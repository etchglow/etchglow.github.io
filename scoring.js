/* ============================================================================
   Shared transfer-match confidence scoring + UI, used by index.html, team.html,
   and transfer-portal.html.

   This is the single source of truth for everything client-side pages need to
   identify and score a transfer pairing:
     - the school-name matching machinery (classifyOrigin and friends) that
       turns a player's free-text previous-school bio into a resolved school,
       previously hand-duplicated in team.html and transfer-portal.html
     - the field-comparison helpers (hometown/high school/class/position) used
       both to gate a match (corroborated or not) and to score one
     - the additive 0-100 confidence score itself, plus the tier labels
     - small DOM helpers for rendering a score badge and a click-to-open
       breakdown popover, so the "why" behind a number is never more than a
       click away on any page that shows one

   Name-match scoring (a departed player matched by name against a New arrival
   elsewhere) is computed server-side now - see RosterScraperService.ScoreNameMatch
   - and travels on the Gone player's own JSON record (matchScore/matchTier/
   matchComponents). Scoring.nameMatchScore() below prefers that whenever it's
   present, and only falls back to recomputing client-side for snapshots
   scraped before those fields existed (the same "populated only for snapshots
   scraped after that field was added" pattern already used for previousSchool).

   Bio-match and exp-match scoring stay client-side, same as classifyOrigin
   itself always has: both need the *whole* accumulated data.json (every
   conference ever scraped, not just this run's slice) plus a live fetch of the
   external non-D3 school catalog, neither of which a single scrape invocation
   has available server-side.

   Everything is exposed on a single `Scoring` global rather than bare function
   names, so it can't collide with any page-specific helper of the same name. */
(function (global) {
  "use strict";

  /* ============ school-name matching (classifyOrigin machinery) ============ */

  function normalizeSchoolText(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[.’']/g, "")
      .replace(/^\s*the\s+/, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  async function loadNonD3Schools() {
    try {
      const res = await fetch('https://etchglow.github.io/non-d3-football-schools.json', { cache: "no-store" });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.schools) ? data.schools : [];
    } catch (e) { return []; }
  }

  /* Real-world initialisms/shorthand seen in scraped bios that no mechanical strip rule can
     derive - each entry is verified against an actual roster snapshot before being added here,
     not guessed preemptively, to keep this list from becoming a source of new false positives. */
  const MANUAL_SCHOOL_ALIASES = {
    "University of Mary Hardin-Baylor": ["UMHB"],
    "University of Texas Permian Basin": ["UTPB"],
    "University of Texas Rio Grande Valley": ["UTRGV"],
    "University of North Texas": ["UNT"],
    "Eastern New Mexico University": ["ENMU", "Eastern N.M."],
  };

  /* Every school gets its full name indexed, plus mechanical variants with a trailing
     "University"/"College" or a leading "University of " stripped. A bare single-word variant
     is trusted on the same footing as a multi-word one - see previousSchoolCandidates for why
     every candidate this reaches now comes from a structurally dedicated position rather than
     free-text high-school field guessing. */
  function addSchoolAliases(map, name, entry) {
    const add = (variant) => { const n = normalizeSchoolText(variant); if (n) map.set(n, entry); };
    add(name);
    const trailingStripped = name.replace(/\s+(university|college)\s*$/i, "").trim();
    if (trailingStripped && trailingStripped.toLowerCase() !== name.toLowerCase()) add(trailingStripped);
    const leadingStripped = name.replace(/^\s*university of\s+/i, "").trim();
    if (leadingStripped && leadingStripped.toLowerCase() !== name.toLowerCase()) add(leadingStripped);
    const extra = MANUAL_SCHOOL_ALIASES[name];
    if (extra) extra.forEach(add);
  }

  const JUCO_DIVISIONS = new Set(["NJCAA", "CCCAA", "NWAC"]);
  const DIVISION_LABEL = {
    "D1-FBS": "D1 (FBS)", "D1-FCS": "D1 (FCS)", "D2": "D2",
    "NAIA": "NAIA", "NJCAA": "NJCAA", "CCCAA": "CCCAA", "NWAC": "NWAC"
  };

  /* Juco names additionally get "X CC" / "X JC" / "X Community College" variants, since roster
     bios abbreviate juco names far more inconsistently than four-year schools. */
  function buildNonD3Index(schools) {
    const map = new Map();
    const add = (variant, entry) => { const n = normalizeSchoolText(variant); if (n) map.set(n, entry); };
    schools.forEach(s => {
      const entry = { name: s.name, division: s.division };
      addSchoolAliases(map, s.name, entry);
      if (JUCO_DIVISIONS.has(s.division)) {
        const base = s.name.replace(/\s+(community college|junior college|college)\s*$/i, "").trim();
        if (base && base.toLowerCase() !== s.name.toLowerCase()) {
          add(base, entry); add(base + " CC", entry); add(base + " JC", entry);
          add(base + " Community College", entry); add(base + " College", entry);
        }
      }
    });
    return map;
  }

  function buildD3Index(schools) {
    const map = new Map();
    schools.forEach(s => addSchoolAliases(map, s.name, { name: s.name, confName: s.confName }));
    return map;
  }

  /* Prefers the dedicated previousSchool field (only populated for snapshots scraped after that
     field was added). Older snapshots fall back to the free-text highSchool field's trailing
     parenthetical/"/" split - the only two positions a prior college shows up there. Deliberately
     NOT falling back to the whole highSchool field: a real high school sharing its bare name with
     a tracked college ("Hamilton", "Manchester", "Eureka", ...) produced false positives when this
     was tried - see the transfer-match audit. */
  function previousSchoolCandidates(p) {
    if (p.previousSchool && p.previousSchool.trim()) return [p.previousSchool.trim()];
    const text = String(p.highSchool || "").trim();
    if (!text) return [];
    const parenMatch = text.match(/\(([^)]+)\)\s*$/);
    if (parenMatch) {
      const inner = parenMatch[1].trim();
      return inner.includes("/") ? inner.split("/").map(s => s.trim()).filter(Boolean).reverse() : [inner];
    }
    if (text.includes("/")) {
      const parts = text.split("/");
      return [parts[parts.length - 1].trim()];
    }
    return [];
  }

  function classifyOrigin(p, nonD3Index, d3Index) {
    for (const candidate of previousSchoolCandidates(p)) {
      if (!candidate) continue;
      const n = normalizeSchoolText(candidate);
      const d3Hit = d3Index.get(n);
      if (d3Hit) return { text: candidate, matchedName: d3Hit.name, matchedConf: d3Hit.confName, scope: "d3", division: null };
      const hit = nonD3Index.get(n);
      if (hit) return { text: candidate, matchedName: hit.name, matchedConf: null, scope: "non-d3", division: hit.division };
    }
    return null;
  }

  function findPlayerAtSchool(schools, schoolName, name) {
    const school = schools.find(s => s.name === schoolName);
    if (!school) return null;
    return school.players.find(p => p.name.toLowerCase() === name.toLowerCase()) || null;
  }

  function flattenSchools(data) {
    const list = [];
    data.conferences.forEach(conf => conf.schools.forEach(s => list.push(Object.assign({ confName: conf.name }, s))));
    return list;
  }

  /* A roster site's own Cl./Exp. eligibility tag reads "TR" when the site itself marks a player a
     transfer - independent of, and stronger than, any text inferred from bio text. */
  function isTransferExp(exp) {
    return String(exp || "").trim().toUpperCase() === "TR";
  }

  /* ============ field comparisons ============ */

  function cityTokens(hometown) {
    if (!hometown) return new Set();
    const city = String(hometown).split(",")[0].toLowerCase().replace(/[^a-z0-9\s]/g, " ");
    return new Set(city.split(/\s+/).filter(Boolean));
  }
  function highSchoolTokens(highSchool) {
    if (!highSchool) return new Set();
    let hs = String(highSchool).toLowerCase().replace(/\(.*?\)/g, " ").replace(/high school|senior high|\bhs\b/g, " ");
    hs = hs.replace(/[^a-z0-9\s]/g, " ");
    return new Set(hs.split(/\s+/).filter(Boolean));
  }
  function setsOverlap(a, b) { for (const x of a) if (b.has(x)) return true; return false; }
  // "Agree" | "Conflict" | "Unknown"
  function compareTokenSets(a, b) { if (!a.size || !b.size) return "Unknown"; return setsOverlap(a, b) ? "Agree" : "Conflict"; }

  const CLASS_RANK_PATTERNS = [
    [/\b(gr|grad|graduate|5th|fifth|super\s*senior)\b/i, 5],
    [/\b(sr|senior)\b/i, 4],
    [/\b(jr|junior)\b/i, 3],
    [/\b(so|sophomore)\b/i, 2],
    [/\b(fr|fy|freshman|first[\s-]?year)\b/i, 1],
  ];
  function classRank(cls) {
    const text = String(cls || "").trim();
    if (!text) return null;
    for (const [pattern, rank] of CLASS_RANK_PATTERNS) if (pattern.test(text)) return rank;
    return null;
  }

  // Position, unlike hometown/high school, is not permanent - a real transfer legitimately
  // switches positions often enough (WR<->DB, RB<->LB, ATH into anything) that a mismatch can't
  // gate a match closed the way a conflicting hometown does. It only ever nudges the score.
  const POSITION_GROUPS = {
    QB: ['qb', 'quarterback'],
    RB: ['rb', 'runningback', 'tb', 'tailback', 'hb', 'halfback'],
    FB: ['fb', 'fullback', 'hback', 'h'],
    WR: ['wr', 'widereceiver', 'receiver', 'sl', 'slot', 'slotback', 'sb', 'x'],
    TE: ['te', 'tightend'],
    OL: ['ol', 'offensiveline', 'ot', 'og', 'oc', 'c', 't', 'g', 'tackle', 'guard', 'center', 'lt', 'rt', 'lg', 'rg'],
    DL: ['dl', 'defensiveline', 'de', 'dt', 'nt', 'defensiveend', 'defensivetackle', 'nosetackle', 'edge'],
    LB: ['lb', 'linebacker', 'olb', 'ilb', 'mlb', 'wlb', 'outsidelinebacker', 'insidelinebacker', 'rush'],
    DB: ['db', 'defensiveback', 'cb', 'cornerback', 'cornback', 's', 'safety', 'fs', 'ss', 'freesafety',
      'strongsafety', 'nb', 'nickel', 'star', 'spur', 'rover', 'rov', 'bandit', 'saf'],
    K: ['k', 'pk', 'kicker'],
    P: ['p', 'punter'],
    LS: ['ls', 'longsnapper'],
  };
  const POSITION_LOOKUP = new Map();
  for (const [group, aliases] of Object.entries(POSITION_GROUPS))
    for (const alias of aliases) POSITION_LOOKUP.set(alias, group);

  function normalizePositionGroups(raw) {
    const text = String(raw || '').toLowerCase();
    const groups = new Set();
    text.split(/[^a-z]+/).filter(Boolean).forEach(t => { const g = POSITION_LOOKUP.get(t); if (g) groups.add(g); });
    return groups;
  }
  function comparePositions(a, b) {
    const ga = normalizePositionGroups(a), gb = normalizePositionGroups(b);
    if (!ga.size || !gb.size) return 'Unknown';
    for (const g of ga) if (gb.has(g)) return 'Agree';
    return 'Conflict';
  }

  /* ============ match-confidence components (score breakdown) ============ */

  function classComponent(departed, arrived) {
    const ra = classRank(departed.cls), rb = classRank(arrived.cls);
    if (ra == null || rb == null) return { label: 'Class progression', a: departed.cls || '—', b: arrived.cls || '—', verdict: 'Unknown', points: 0 };
    if (rb < ra) return { label: 'Class progression', a: departed.cls, b: arrived.cls, verdict: 'Conflict', points: 0 };
    if (rb - ra === 1) return { label: 'Class progression', a: departed.cls, b: arrived.cls, verdict: 'Agree', points: 3 };
    return { label: 'Class progression', a: departed.cls, b: arrived.cls, verdict: 'Neutral', points: 0 };
  }
  function positionComponent(departed, arrived) {
    const verdict = comparePositions(departed.position, arrived.position);
    const points = verdict === 'Agree' ? 4 : verdict === 'Conflict' ? -4 : 0;
    return { label: 'Position', a: departed.position || '—', b: arrived.position || '—', verdict, points };
  }
  // Hometown/high school carry points:null deliberately - they decide which base-score bucket
  // applies (see nameMatchScore/bioMatchScore) rather than adding their own points on top of it.
  function identityComponents(departed, arrived) {
    const hometown = compareTokenSets(cityTokens(departed.hometown), cityTokens(arrived.hometown));
    const highSchool = compareTokenSets(highSchoolTokens(departed.highSchool), highSchoolTokens(arrived.highSchool));
    return [
      { label: 'Hometown', a: departed.hometown || '—', b: arrived.hometown || '—', verdict: hometown, points: null },
      { label: 'High school', a: departed.highSchool || '—', b: arrived.highSchool || '—', verdict: highSchool, points: null },
      classComponent(departed, arrived),
      positionComponent(departed, arrived),
    ];
  }
  function modifierPoints(comps) { return comps.reduce((sum, c) => sum + (c.points || 0), 0); }
  function modifierSuffix(comps) {
    const parts = [];
    const cls = comps.find(c => c.label === 'Class progression');
    if (cls && cls.points > 0) parts.push(`class advances (${cls.a} → ${cls.b})`);
    const pos = comps.find(c => c.label === 'Position');
    if (pos) {
      if (pos.verdict === 'Agree') parts.push(`position agrees (${pos.a})`);
      else if (pos.verdict === 'Conflict') parts.push(`position differs (${pos.a} vs ${pos.b})`);
    }
    return parts.length ? '; ' + parts.join(', ') : '';
  }
  function clampScore(n) { return Math.max(0, Math.min(100, n)); }
  function tierFor(score) {
    if (score >= 90) return 'Confirmed';
    if (score >= 70) return 'High confidence';
    if (score >= 40) return 'Likely';
    return 'Unconfirmed';
  }
  function baseOnly(text, score) {
    return { score, tier: tierFor(score), detail: text, components: [{ label: 'Evidence source', text, points: score }] };
  }

  // Same gate RosterScraperService.IsCorroborated applies server-side: a regressed class year or
  // a conflicting hometown/high school rejects the match outright; otherwise at least one of
  // hometown/high school has to actively agree. Position never enters this decision.
  function isCorroboratedFromComponents(comps) {
    const hometown = comps[0].verdict, highSchool = comps[1].verdict, classVerdict = comps[2].verdict;
    if (classVerdict === 'Conflict' || hometown === 'Conflict' || highSchool === 'Conflict') return false;
    return hometown === 'Agree' || highSchool === 'Agree';
  }
  // Kept under its original name/signature for any page code still calling it directly.
  function isCorroborated(departed, arrived) { return isCorroboratedFromComponents(identityComponents(departed, arrived)); }

  /* Client-side mirror of RosterScraperService.ScoreNameMatch, used only as a fallback for
     snapshots scraped before matchScore/matchTier/matchComponents existed on the Gone player's
     own JSON record - see nameMatchScore below, which prefers the backend-computed value
     whenever it's present so there's exactly one place this formula lives in practice. */
  function scoreNameMatchClient(departed, arrived) {
    const comps = identityComponents(departed, arrived);
    const hometown = comps[0].verdict, highSchool = comps[1].verdict;
    let base, baseText;
    if (hometown === 'Agree' && highSchool === 'Agree') { base = 85; baseText = 'Name-match: unique name pairing, hometown + high school both agree'; }
    else { base = 62; baseText = `Name-match: unique name pairing, ${hometown === 'Agree' ? 'hometown' : 'high school'} agrees`; }
    const score = clampScore(base + modifierPoints(comps));
    return {
      score, tier: tierFor(score), detail: baseText + modifierSuffix(comps),
      components: [{ label: 'Evidence source', text: baseText, points: base }, ...comps]
    };
  }

  /* The function pages actually call for a name-match pairing (a "Gone" player whose
     departureReason resolved to "Transferred to X"). Prefers the score the backend already
     computed and attached to the Gone player's JSON record; only recomputes client-side for a
     snapshot old enough not to carry those fields. */
  function nameMatchScore(departed, arrived) {
    if (departed && departed.matchTier && Array.isArray(departed.matchComponents) && departed.matchComponents.length) {
      return { score: departed.matchScore, tier: departed.matchTier, components: departed.matchComponents };
    }
    if (!arrived) return baseOnly('Name-match, destination name did not resolve to a tracked roster', 30);
    return scoreNameMatchClient(departed, arrived);
  }

  function bioMatchScore(originPlayer, player, scope) {
    if (scope === 'd3') {
      if (!originPlayer) return baseOnly('Self-reported previous school (D3), no same-named record there to cross-check', 90);
      const comps = identityComponents(originPlayer, player);
      if (isCorroboratedFromComponents(comps)) {
        const base = 97;
        const score = clampScore(base + modifierPoints(comps));
        const baseText = 'Self-reported previous school (D3) + independent roster record corroborates';
        return { score, tier: tierFor(score), detail: baseText + modifierSuffix(comps), components: [{ label: 'Evidence source', text: baseText, points: base }, ...comps] };
      }
      const base = 60;
      const score = clampScore(base + modifierPoints(comps));
      const baseText = 'Self-reported previous school (D3), but same-named record there conflicts (hometown/HS/class)';
      return { score, tier: tierFor(score), detail: baseText + modifierSuffix(comps), components: [{ label: 'Evidence source', text: baseText, points: base }, ...comps] };
    }
    return baseOnly(`Self-reported previous school (non-D3, ${originPlayer ? 'checked' : 'unverifiable roster'})`, 82);
  }

  // The bare "TR" tag is the site's own eligibility system marking this specific player a
  // transfer - not our inference, the school's. That's confirmed on its own, same epistemic
  // footing as a self-reported previous school, even with nothing else backing it up. It only
  // confirms transfer *status*, not the origin - a resolved non-D3 origin on top of it adds real
  // provenance and scores a bit higher, but the bare tag alone still clears the Confirmed bar.
  function scoreExpMatch(origin) {
    if (origin) return baseOnly(`TR tag (site-confirmed transfer) + resolved non-D3 origin (${origin.division})`, 93);
    return baseOnly('TR tag (site-confirmed transfer), origin not resolvable from bio text', 90);
  }

  /* ============ UI: confidence badge + breakdown popover ============ */

  let uiReady = false;
  function initUI() {
    if (uiReady) return;
    uiReady = true;

    const style = document.createElement('style');
    style.textContent = `
      .sc-badge{display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:10px;
        letter-spacing:.04em;text-transform:uppercase;padding:2px 8px 2px 6px;border-radius:999px;
        border:1px solid transparent;cursor:pointer;background:none;line-height:1.6;}
      .sc-badge:hover{filter:brightness(1.15);}
      .sc-badge .sc-dot{width:6px;height:6px;border-radius:50%;flex:none;}
      .sc-badge.sc-confirmed{background:rgba(201,162,39,0.16);color:var(--gold-bright);}
      .sc-badge.sc-confirmed .sc-dot{background:var(--gold-bright);}
      .sc-badge.sc-high{background:rgba(159,176,163,0.16);color:var(--muted);}
      .sc-badge.sc-high .sc-dot{background:var(--muted);}
      .sc-badge.sc-likely{background:rgba(178,74,58,0.14);color:var(--rust-bright);}
      .sc-badge.sc-likely .sc-dot{background:var(--rust-bright);}
      .sc-badge.sc-unconfirmed{background:rgba(92,107,98,0.18);color:var(--stale);}
      .sc-badge.sc-unconfirmed .sc-dot{background:var(--stale);}

      .sc-popover{position:fixed;z-index:9999;width:320px;max-width:calc(100vw - 24px);
        background:var(--field-dark);border:1px solid var(--line);border-radius:8px;
        box-shadow:0 12px 32px rgba(0,0,0,0.5);padding:14px 16px 12px;display:none;
        font-family:var(--body);color:var(--chalk);}
      .sc-popover.sc-open{display:block;}
      .sc-popover-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;
        padding-bottom:9px;margin-bottom:7px;border-bottom:1px solid var(--line);}
      .sc-popover-head strong{font-size:13.5px;color:var(--chalk);}
      .sc-popover-head span{font-size:11px;color:var(--muted);white-space:nowrap;font-family:var(--mono);}
      .sc-popover-close{position:absolute;top:8px;right:10px;border:0;background:transparent;
        color:var(--muted);cursor:pointer;font-size:16px;line-height:1;padding:2px;}
      .sc-popover-close:hover{color:var(--chalk);}
      .sc-comp-row{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:6px 0;
        border-bottom:1px solid var(--line);align-items:start;}
      .sc-comp-row:last-of-type{border-bottom:0;}
      .sc-comp-label{font-size:10.5px;font-family:var(--mono);letter-spacing:.03em;color:var(--muted);
        display:flex;align-items:center;gap:6px;grid-column:1/-1;text-transform:uppercase;}
      .sc-comp-value{font-size:12px;color:var(--chalk);line-height:1.4;}
      .sc-comp-value .sc-vs{color:var(--muted);margin:0 4px;}
      .sc-comp-points{font-family:var(--mono);font-size:12px;color:var(--muted);white-space:nowrap;text-align:right;}
      .sc-comp-points.sc-pos{color:var(--gold-bright);}
      .sc-comp-points.sc-neg{color:var(--rust-bright);}
      .sc-verdict{font-family:var(--mono);font-size:9.5px;letter-spacing:.03em;padding:1px 6px;border-radius:999px;}
      .sc-verdict.sc-agree{background:rgba(201,162,39,0.18);color:var(--gold-bright);}
      .sc-verdict.sc-conflict{background:rgba(178,74,58,0.2);color:var(--rust-bright);}
      .sc-verdict.sc-neutral{background:rgba(159,176,163,0.16);color:var(--muted);}
      .sc-verdict.sc-unknown{background:rgba(92,107,98,0.22);color:var(--stale);}
      .sc-comp-total{display:flex;justify-content:space-between;align-items:center;margin-top:7px;
        padding-top:9px;border-top:1px solid var(--line);font-family:var(--mono);}
      .sc-comp-total .sc-t-label{font-size:11px;color:var(--muted);}
      .sc-comp-total .sc-t-value{font-size:16px;color:var(--chalk);}
    `;
    document.head.appendChild(style);

    const popover = document.createElement('div');
    popover.className = 'sc-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-hidden', 'true');
    popover.setAttribute('aria-label', 'Score breakdown');
    popover.innerHTML = `<button class="sc-popover-close" type="button" aria-label="Close">&times;</button><div class="sc-popover-body"></div>`;
    document.body.appendChild(popover);

    const body = popover.querySelector('.sc-popover-body');
    let openEl = null;

    function verdictClass(v) {
      return v === 'Agree' ? 'sc-agree' : v === 'Conflict' ? 'sc-conflict' : v === 'Neutral' ? 'sc-neutral' : 'sc-unknown';
    }
    function esc(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }
    function renderComponent(c) {
      const hasPoints = c.points !== null && c.points !== undefined;
      const pointsText = hasPoints ? (c.points > 0 ? `+${c.points}` : `${c.points}`) : '';
      const pointsClass = hasPoints ? (c.points > 0 ? 'sc-pos' : c.points < 0 ? 'sc-neg' : '') : '';
      const value = c.text !== undefined ? esc(c.text) : `${esc(c.a)}<span class="sc-vs">vs</span>${esc(c.b)}`;
      return `<div class="sc-comp-row">
        <div class="sc-comp-label">${esc(c.label)}${c.verdict ? `<span class="sc-verdict ${verdictClass(c.verdict)}">${esc(c.verdict)}</span>` : ""}</div>
        <div class="sc-comp-value">${value}</div><div></div>
        <div class="sc-comp-points ${pointsClass}">${pointsText}</div>
      </div>`;
    }
    function position(el) {
      const r = el.getBoundingClientRect();
      const width = 320;
      let left = r.left;
      if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12;
      if (left < 12) left = 12;
      let top = r.bottom + 8;
      const estHeight = popover.offsetHeight || 240;
      if (top + estHeight > window.innerHeight - 12) top = Math.max(12, r.top - estHeight - 8);
      popover.style.left = left + "px";
      popover.style.top = top + "px";
    }
    function close() {
      if (!openEl) return;
      openEl.setAttribute('aria-expanded', 'false');
      openEl = null;
      popover.classList.remove('sc-open');
      popover.setAttribute('aria-hidden', 'true');
    }
    function open(el, info) {
      if (openEl === el) { close(); return; }
      body.innerHTML = `
        <div class="sc-popover-head"><strong>${esc(info.title)}</strong><span>${esc(info.subtitle || "")}</span></div>
        ${info.components.map(renderComponent).join("")}
        <div class="sc-comp-total"><span class="sc-t-label">Total (capped 0–100)</span><span class="sc-t-value">${info.score}</span></div>
      `;
      document.querySelectorAll('.sc-badge[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
      el.setAttribute('aria-expanded', 'true');
      popover.classList.add('sc-open');
      popover.setAttribute('aria-hidden', 'false');
      openEl = el;
      position(el);
    }

    // Reposition rather than close on scroll/resize - closing here was tried first, but a
    // capture-phase scroll listener also fires for the scroll-into-view a browser performs when
    // an off-screen badge is clicked or focused, which raced with open() and closed the popover
    // within the same interaction that opened it. Repositioning keeps it correctly anchored to
    // its trigger badge either way, without that race. Guards against a stale openEl left over
    // from a page that replaced its DOM (a filter-triggered redraw) while the popover was open.
    function repositionOrClose() {
      if (!openEl) return;
      if (!document.body.contains(openEl)) { close(); return; }
      position(openEl);
    }
    popover.querySelector('.sc-popover-close').addEventListener('click', close);
    document.addEventListener('click', (ev) => { if (openEl && !popover.contains(ev.target) && !ev.target.closest('.sc-badge')) close(); });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(); });
    window.addEventListener('resize', repositionOrClose);
    document.addEventListener('scroll', repositionOrClose, true);

    global.Scoring._open = open;
    global.Scoring._close = close;
  }

  function tierClass(tier) {
    return tier === 'Confirmed' ? 'sc-confirmed' : tier === 'High confidence' ? 'sc-high' : tier === 'Likely' ? 'sc-likely' : 'sc-unconfirmed';
  }

  /* Renders a clickable badge for {score, tier, components} and wires its popover. title/subtitle
     are shown in the popover header (e.g. player name / "From School → To School"). Call
     Scoring.initUI() once per page before using this. The breakdown travels as a data attribute
     on the button itself (not a side lookup table) so pages that redraw their whole list on every
     filter change (both team.html and transfer-portal.html do) don't leak an entry per redraw -
     the data is garbage-collected along with the DOM node it's attached to. */
  function escapeAttr(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }
  function badge(result, title, subtitle) {
    return `<button class="sc-badge ${tierClass(result.tier)}" type="button" data-sc-title="${escapeAttr(title)}" data-sc-subtitle="${escapeAttr(subtitle || "")}" data-sc-components="${escapeAttr(JSON.stringify(result.components))}" aria-haspopup="dialog" aria-expanded="false" title="${escapeAttr(result.tier)} · ${result.score}/100 — click for the field-by-field breakdown"><span class="sc-dot"></span>${result.score}</button>`;
  }

  /* Call after inserting any HTML produced by Scoring.badge() into the DOM (e.g. after setting
     .innerHTML) so the click-to-open behavior actually attaches. Safe to call repeatedly / on a
     container with zero badges - already-wired buttons are skipped. */
  function wireBadges(root) {
    initUI();
    (root || document).querySelectorAll('.sc-badge:not([data-sc-wired])').forEach(el => {
      el.setAttribute('data-sc-wired', '1');
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const score = el.textContent.trim();
        let components = [];
        try { components = JSON.parse(el.dataset.scComponents || '[]'); } catch (e) { /* malformed - show an empty breakdown rather than throwing */ }
        global.Scoring._open(el, { title: el.dataset.scTitle, subtitle: el.dataset.scSubtitle, components, score });
      });
    });
  }

  global.Scoring = {
    // matching
    normalizeSchoolText, addSchoolAliases, MANUAL_SCHOOL_ALIASES, JUCO_DIVISIONS, DIVISION_LABEL,
    loadNonD3Schools, buildNonD3Index, buildD3Index, previousSchoolCandidates, classifyOrigin,
    findPlayerAtSchool, flattenSchools, isTransferExp,
    // field comparisons
    cityTokens, highSchoolTokens, compareTokenSets, classRank, comparePositions,
    identityComponents, isCorroborated, isCorroboratedFromComponents,
    // scoring
    tierFor, clampScore, nameMatchScore, bioMatchScore, scoreExpMatch,
    // UI
    initUI, badge, wireBadges,
  };
})(window);
