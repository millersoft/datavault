/* Studio Plus — report planning, SQL generation/validation, result sampling and workbook export. */
// Shared by every prompt that asks the model for render_js, so sections look
// like one report. The shell also enforces contrast and containment at runtime
// (see spReportStyleGuard), but steering the model avoids relying on that.
const SP_REPORT_STYLE_GUIDE = `STYLE RULES (the report page is light: white cards on a pale lilac background):
- Use ONLY this palette. Text: #1a0a1e (body), #2c1238 (headings/values), #7a6b84 (muted labels). Accent/series colours: #7b1fa2, #2a7f9e, #e08a1e, #2e8b57, #c2410c, #4a2060, #6b7280, #b83280. Surfaces: #ffffff, #faf7fc, #f6eefb, borders #e2d3ec.
- Never set white or light text unless you also set the same element's background to a dark palette colour (#4a2060 or darker). Never put purple text on a purple background. Whenever you set a background colour, set the text colour explicitly beside it. Do not rely on inherited colour inside coloured cells, badges, heatmap cells or legend chips; heatmap cells must pick dark or white text from the cell's own background.
- Available CSS classes: sp-kpi-grid, sp-kpi, sp-kpi-label, sp-kpi-value, sp-kpi-sub, sp-grid-2, sp-chart, sp-insight, sp-toolbar, sp-pill. Prefer them over inline styles.
- Everything must fit inside the section card at any width: never use fixed pixel widths wider than 100%; use width:100% / max-width:100%, CSS grid with repeat(auto-fit,minmax(240px,1fr)), and flex-wrap. Wrap wide tables in a div with overflow-x:auto. Inline SVG must use a viewBox and width="100%" (no fixed width/height attributes larger than the card). ECharts containers must be width:100% with an explicit height of 280-380px, use grid.containLabel:true, and truncate or rotate long axis labels (axisLabel.width / overflow:'truncate'). Cap categorical charts at 12-15 items (top N plus "Other").`;

async function spSuggestDashboardPlan(){
  if (!spSelectedSchemaTables().length){ toast('Select at least one business model for reporting first.', 'err'); return; }
  spDashboardPlanStatus = 'loading';
  renderAll();
  const standardRules = `You are a senior BI analyst. You are given ONLY the tables/views selected for reporting from a Data Vault / Business Vault environment. Every supplied object is an approved business model managed by Studio Plus. Use ONLY the supplied selected objects and columns. Based ONLY on these names — no row values exist or should be assumed — design ONE comprehensive, cohesive dashboard for this data, not a list of separate unrelated report ideas. Propose 4 to 7 sections that together tell a complete story about this schema — typically an overview/KPI section plus several more specific breakdowns — each one a piece of a single dashboard rather than a standalone report.
Respond with ONLY minified JSON, no prose, no markdown fences, matching exactly this shape:
{"title":"short dashboard title","sections":[{"name":"short section name","description":"1-2 sentences on what this section shows and roughly which tables it draws from"}]}`;
  const businessRules = `You are the business-analysis lead on a BI consulting engagement. You are given a selected curated-dataset reporting scope, table/view row counts, actual data types, and an authoritative list of valid joins. Every object in scope is an approved business model managed by Studio Plus. Use ONLY these selected objects. Do NOT jump straight to generic charts. First infer the likely business entities, events, lifecycle/status concepts, measures, dates and useful decision questions supported by the schema. Then design ONE cohesive, business-ready analytical report with 4 to 8 complementary sections.

The quality bar is a consultant-built analytical application, not a table browser. Where the available fields support them, actively consider techniques such as: executive KPI/variance summary; lifecycle or funnel analysis; cohort/retention analysis; recency-frequency-value or other scoring/segmentation; Pareto/concentration; contribution analysis; rankings; stage ageing and velocity; conversion; trends and period comparisons; exception analysis; performance bands; relationship/network analysis; and historical change from satellites. Only choose techniques that the supplied schema can actually support. Never invent a field, business event, relationship, target, budget or benchmark that is not evidenced by the schema.

Each proposed section must answer a distinct business question and state the analytical technique it will use. The sections should tell a story together: orient the reader, explain drivers, expose segments/behaviour, and finish with actionable detail or exceptions. Avoid proposing multiple sections that are merely the same aggregation sliced a different way.

Respond with ONLY minified JSON, no prose, no markdown fences, matching exactly this shape:
{"title":"short business report title","report_goal":"one sentence describing the decisions this report helps with","sections":[{"name":"short section name","business_question":"the decision-useful question answered","analysis_type":"e.g. Executive summary, Cohort analysis, RFV segmentation, Funnel, Pareto, Trend, Exceptions","description":"1-2 sentences describing the analysis and the likely vault objects involved"}]}`;
  const rules = spBusinessReady ? businessRules : standardRules;
  const focus = String(spCustomDirection || '').trim();
  const userMsg = `${focus ? `The person's stated focus for this report (let it steer which sections you propose, but still use only the supplied objects and columns):\n${focus}\n\n` : ''}Selected curated-view reporting scope (table_or_view[row count](column:data_type, ...)) and authoritative joins:\n${spSchemaSummaryWithJoinsText()}`;
  try {
    const parsed = await spCallOpenAI(rules, userMsg, spBusinessReady ? 0.35 : 0.4);
    if (!parsed.title || !Array.isArray(parsed.sections) || !parsed.sections.length) throw new Error('Model response was missing a title or sections.');
    spDashboardPlan = parsed;
    spSectionsIncluded = new Set(parsed.sections.map((_,i)=>i));
    spDashboardPlanStatus = 'ok';
    toast(`Proposed "${parsed.title}" with ${parsed.sections.length} section(s).`, 'ok');
  } catch(err){
    spDashboardPlanStatus = 'error';
    toast('Could not get a report suggestion: ' + err.message, 'err');
  }
  renderAll();
}

function spValidationSql(sql){
  const body=String(sql||'').trim().replace(/;\s*$/,'');
  return spIsSqlServerDialect()?`SELECT TOP (0) * FROM (${body}) AS _sp_validate`:`SELECT * FROM (${body}) AS _sp_validate LIMIT 0`;
}

async function spValidateViewList(views){
  const results = {};
  for (const v of (views||[])){
    const key = spViewKey(v);
    const sql=spOverrides[key] != null ? spOverrides[key] : (v.sql||'');
    const shapeIssue=spReportSqlIssue(sql);
    if(shapeIssue){results[key]={ok:false,error:shapeIssue};continue;}
    try {
      await spQuery(spValidationSql(spNormalizeReportSql(sql)));
      results[key] = { ok:true };
    } catch(err){
      results[key] = { ok:false, error:err.message };
    }
  }
  return results;
}

// The downloaded HTML runs each section as
// new Function("rows", "el", "echarts", render_js). Models often return a
// complete function, a markdown fence, or an extra } / ] after the script.
// Firefox then reports "unexpected garbage after function body, starting
// with ']'". Compile the same way here, before the file is offered for download.
function spCoerceRenderJs(value){
  if (Array.isArray(value)) return value.map(line=>String(line ?? '')).join('\n');
  return String(value ?? '');
}
function spStripSectionRenderFences(code){
  let text = spCoerceRenderJs(code).replace(/^\uFEFF/, '').trim();
  const whole = text.match(/^```(?:javascript|js)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/i);
  if (whole) return whole[1].trim();
  const inner = text.match(/```(?:javascript|js)?[ \t]*\r?\n([\s\S]*?)\r?\n```/i);
  return inner ? inner[1].trim() : text;
}
function spSkipJsTrivia(text, index){
  let i = index;
  while (i < text.length){
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'){ i++; continue; }
    if (c === '/' && text[i + 1] === '/'){
      i += 2;
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*'){
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    break;
  }
  return i;
}
function spJsPrevToken(text, index){
  let j = index - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (j < 0) return '';
  if (!/[\w$]/.test(text[j])) return text[j];
  const end = j;
  while (j >= 0 && /[\w$]/.test(text[j])) j--;
  return text.slice(j + 1, end + 1);
}
const SP_REGEX_PREFIX_CHARS = new Set(['(', '[', '{', ',', ';', '=', '!', '?', '&', '|', '+', '-', '*', '%', '~', '^', '<', '>', ':']);
const SP_REGEX_PREFIX_WORDS = new Set(['return', 'typeof', 'case', 'throw', 'void', 'in', 'of', 'do', 'else', 'await', 'yield', 'delete', 'new']);
function spJsRegexLikely(text, index){
  const prev = spJsPrevToken(text, index);
  if (!prev) return true;
  if (SP_REGEX_PREFIX_CHARS.has(prev)) return true;
  return SP_REGEX_PREFIX_WORDS.has(prev);
}
function spJsSkipRegex(text, index){
  let i = index + 1;
  while (i < text.length){
    const c = text[i];
    if (c === '\\'){ i += 2; continue; }
    if (c === '['){
      i++;
      while (i < text.length && text[i] !== ']' && text[i] !== '\n'){
        if (text[i] === '\\') i += 2;
        else i++;
      }
      continue;
    }
    if (c === '/' || c === '\n') return i + 1;
    i++;
  }
  return text.length;
}
function spJsSkipString(text, index){
  const quote = text[index];
  let i = index + 1;
  while (i < text.length){
    const c = text[i];
    if (c === '\\'){ i += 2; continue; }
    if (c === quote) return i + 1;
    if (quote === '`' && c === '$' && text[i + 1] === '{'){
      const end = spJsMatchCloser(text, i + 1, '{', '}');
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    i++;
  }
  return text.length;
}
function spJsMatchCloser(text, openIndex, openCh, closeCh){
  let depth = 0;
  for (let i = openIndex; i < text.length; i++){
    const c = text[i];
    if (c === "'" || c === '"' || c === '`'){
      i = spJsSkipString(text, i) - 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/'){
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*'){
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length - 1 : end + 1;
      continue;
    }
    if (c === '/' && spJsRegexLikely(text, i)){
      i = spJsSkipRegex(text, i) - 1;
      continue;
    }
    if (c === openCh) depth++;
    else if (c === closeCh){
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function spUnwrapSoleSectionFunction(text){
  const source = String(text || '');
  let i = spSkipJsTrivia(source, 0);
  if (i >= source.length) return null;
  let bodyStart = -1;
  let bodyEnd = -1;
  if (source.startsWith('function', i) && /[^A-Za-z0-9_$]/.test(source[i + 8] || ' ')){
    i = spSkipJsTrivia(source, i + 8);
    if (/[A-Za-z_$]/.test(source[i] || '')){
      while (i < source.length && /[\w$]/.test(source[i])) i++;
      i = spSkipJsTrivia(source, i);
    }
    if (source[i] !== '(') return null;
    const paramsEnd = spJsMatchCloser(source, i, '(', ')');
    if (paramsEnd < 0) return null;
    i = spSkipJsTrivia(source, paramsEnd + 1);
    if (source[i] !== '{') return null;
    const braceEnd = spJsMatchCloser(source, i, '{', '}');
    if (braceEnd < 0) return null;
    bodyStart = i + 1;
    bodyEnd = braceEnd;
    i = braceEnd + 1;
  } else {
    const arrow = source.slice(i).match(/^(?:\((?:[^()]|\([^()]*\))*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/);
    if (!arrow) return null;
    const braceAt = i + arrow[0].lastIndexOf('{');
    const braceEnd = spJsMatchCloser(source, braceAt, '{', '}');
    if (braceEnd < 0) return null;
    bodyStart = braceAt + 1;
    bodyEnd = braceEnd;
    i = braceEnd + 1;
  }
  const trailing = source.slice(i).trim();
  if (trailing && !/^[\]\)};,\s]+$/.test(trailing)) return null;
  return source.slice(bodyStart, bodyEnd).trim();
}
function spSectionSyntaxError(code){
  const body = String(code ?? '');
  if (!body.trim()) return 'Section rendering script is empty.';
  try {
    new Function('rows', 'el', 'echarts', body);
    return '';
  } catch (err){
    return err && err.message ? err.message : String(err);
  }
}
function spTrimTrailingSectionGarbage(text){
  let current = String(text || '').trim();
  const original = current;
  if (!current || !spSectionSyntaxError(current)) return current;
  for (let n = 0; n < 16; n++){
    const next = current.replace(/\s*[\]\)};,]\s*$/, '').trim();
    if (!next || next === current) break;
    current = next;
    if (!spSectionSyntaxError(current)) return current;
  }
  return original;
}
function spNormalizeSectionRenderJs(code){
  let text = spStripSectionRenderFences(code).trim();
  if (!text) return '';
  for (let pass = 0; pass < 3; pass++){
    const unwrapped = spUnwrapSoleSectionFunction(text);
    if (unwrapped == null) break;
    const cleaned = spTrimTrailingSectionGarbage(unwrapped);
    if (spSectionSyntaxError(cleaned)) break;
    text = cleaned;
  }
  const trimmed = spTrimTrailingSectionGarbage(text);
  return spSectionSyntaxError(trimmed) ? text : trimmed;
}
function spSectionRenderIssue(code){
  const body = spNormalizeSectionRenderJs(code);
  const syntax = spSectionSyntaxError(body);
  if (syntax) return syntax;
  if (spUnwrapSoleSectionFunction(body)) return 'Section script is wrapped in a function, so the report would not run it.';
  return '';
}
function spCurrentSectionRenderJs(section, index){
  return spSectionOverrides[index] != null ? spSectionOverrides[index] : (section && section.render_js || '');
}
function spRefreshSectionValidation(){
  const results = {};
  ((spGenerated && spGenerated.sections) || []).forEach((section, index)=>{
    const error = spSectionRenderIssue(spCurrentSectionRenderJs(section, index));
    results[index] = error ? { ok:false, error } : { ok:true };
    if (error) spExpanded['sec:' + index] = true;
  });
  spSectionValidation = results;
  return results;
}
function spRejectInvalidSectionScripts(){
  const validation = spRefreshSectionValidation();
  const failed = Object.values(validation).filter(result=>!result.ok).length;
  if (!failed) return false;
  renderAll();
  toast(`${failed} section script${failed === 1 ? '' : 's'} failed JavaScript validation, so the HTML report was not downloaded. Expand the failed section${failed === 1 ? '' : 's'} and fix the script.`, 'err');
  return true;
}
function spRememberSectionValidation(validation){
  spSectionValidation = validation || {};
  Object.entries(spSectionValidation).forEach(([index, result])=>{
    if (result && result.ok === false) spExpanded['sec:' + index] = true;
  });
}
async function spPrepareGeneratedReportSections(sections, views){
  const prepared = (sections || []).map((section, index)=>({
    ...section,
    _index:index,
    render_js:spNormalizeSectionRenderJs(section && section.render_js),
  }));
  const validation = {};
  const validateAt = section=>{
    const error = spSectionRenderIssue(section.render_js);
    validation[section._index] = error ? { ok:false, error } : { ok:true };
  };
  prepared.forEach(validateAt);
  const failed = prepared.filter(section=>!validation[section._index].ok);
  if (failed.length){
    const repairRules = `You repair JavaScript that is the BODY of new Function("rows", "el", "echarts", render_js) in a downloaded HTML report. Return ONLY minified JSON {"sections":[{"index":0,"view_name":"same_name","render_js":"statements only"}]}.

The syntax error supplied for each section is the exact error from that new Function call. "unexpected garbage after function body, starting with ']'" means a } closed the function too early and a later token, often ], was left outside it. Delete the extra brace or bracket.

render_js must be statements only. Do not wrap it in function render(...) { ... }, an arrow function, or a markdown fence. Use only rows, el, echarts and standard browser APIs. Keep the section's analytical intent and use only the supplied dataset columns. An empty rows array must not throw.`;
    const repairInput = JSON.stringify({
      datasets:(views || []).map(view=>({ view_name:view.view_name, columns:view.columns || [], purpose:view.purpose || '' })),
      failed_sections:failed.map(section=>({
        index:section._index,
        view_name:section.view_name,
        title:section.title || '',
        render_js:section.render_js,
        syntax_error:validation[section._index].error,
      })),
    });
    try {
      const repaired = await spCallOpenAI(repairRules, repairInput, 0);
      spApplyRepairedSectionScripts(prepared, validation, repaired);
    } catch (err){
      failed.forEach(section=>{
        if (!validation[section._index].ok) validation[section._index] = { ok:false, error:`${validation[section._index].error} Automatic repair failed: ${err.message}` };
      });
    }
    prepared.forEach(validateAt);
  }
  return {
    sections:prepared.map(section=>{
      const copy = { ...section };
      delete copy._index;
      return copy;
    }),
    validation,
  };
}
function spApplyRepairedSectionScripts(prepared, validation, repaired){
  if (!repaired || !Array.isArray(repaired.sections)) return;
  const failedCountByName = new Map();
  prepared.forEach(section=>{
    if (validation[section._index] && validation[section._index].ok) return;
    const name = String(section.view_name || '');
    failedCountByName.set(name, (failedCountByName.get(name) || 0) + 1);
  });
  repaired.sections.forEach(section=>{
    let index = Number(section.index);
    if (!Number.isInteger(index) || !prepared[index]){
      const name = String(section.view_name || '');
      if (failedCountByName.get(name) === 1){
        index = prepared.findIndex(item=>String(item.view_name || '') === name && validation[item._index] && !validation[item._index].ok);
      }
    }
    if (!Number.isInteger(index) || !prepared[index] || (validation[index] && validation[index].ok)) return;
    prepared[index].render_js = spNormalizeSectionRenderJs(section.render_js);
  });
}

function spSampleSql(sql){ return spSelectLimit(sql,SP_AI_SAMPLE_ROWS); }

function spSanitizeAiSampleRows(rows){
  return (rows||[]).slice(0,SP_AI_SAMPLE_ROWS).map(row=>{
    const out = {};
    Object.keys(row||{}).slice(0,SP_AI_SAMPLE_COLUMNS).forEach(key=>{
      const value = row[key];
      if (value == null || typeof value==='number' || typeof value==='boolean') out[key] = value;
      else {
        const text = String(value);
        out[key] = text.length > SP_AI_SAMPLE_STRING ? text.slice(0,SP_AI_SAMPLE_STRING) + '…' : text;
      }
    });
    return out;
  });
}

async function spCollectResultSamples(views){
  const samples = [];
  let remainingChars = SP_AI_SAMPLE_TOTAL_CHARS;
  for (const v of (views||[])){
    const key = spViewKey(v);
    const sql = spOverrides[key] != null ? spOverrides[key] : (v.sql||'');
    const rows = await spQuery(spSampleSql(sql));
    const sanitized = spSanitizeAiSampleRows(rows);
    const kept = [];
    for (const row of sanitized){
      const cost = JSON.stringify(row).length;
      if (cost > remainingChars) break;
      kept.push(row);
      remainingChars -= cost;
    }
    samples.push({
      view_name:v.view_name,
      sheet_name:v.sheet_name,
      purpose:v.purpose||'',
      columns:v.columns||[],
      sampled_rows:kept,
      sample_truncated:kept.length < sanitized.length,
    });
    if (remainingChars <= 0) break;
  }
  return samples;
}

function spBusinessAnalyticsCookbook(){
  return `ANALYTICS COOKBOOK — choose only what the available data genuinely supports:\n- Executive performance: headline KPIs, current vs prior period, variance, contribution and driver views.\n- Customer/account: lifetime value, RFV/RFM, engagement, acquisition/retention cohorts, repeat behaviour, concentration, segmentation, inactivity/churn proxies.\n- Sales/pipeline: funnel conversion, stage ageing, deal velocity, average deal size, owner performance, won/lost analysis, pipeline mix and coverage when targets exist.\n- Finance: actual/period variance, margin and contribution, revenue/cost bridges, working-capital style ageing where fields exist.\n- Operations: throughput, cycle time, backlog ageing, SLA/exception analysis, capacity/utilisation where fields exist.\n- Data Vault history: entity state over time, change frequency, latest-state snapshots, relationship growth, record-source mix and data freshness.\n- General: Pareto, rankings, cohorts, heatmaps, distributions, quadrants, score bands, anomaly/exception lists and relationship/network views.`;
}

async function spGenerateBusinessReadyReport(directionParts){
  spGenerateStage = 'Planning analytical datasets…';
  renderAll();
  const sqlRules = `You are a senior BI consultant and analytics engineer. Translate the approved business-report blueprint into a small set of robust ${spSqlDialectLabel()} reporting datasets over the selected curated-dataset reporting scope. Use ONLY the supplied selected tables/views; query the supplied curated views directly; do not reconstruct Raw Vault logic behind them.

${spBusinessAnalyticsCookbook()}

SQL RULES:
${spSqlDialectPromptRules()}
- EXACTLY ONE SELECT (or WITH … SELECT) statement per views[].sql. Never emit SET/DECLARE/temp-table setup, CREATE/ALTER/INSERT/UPDATE/DELETE, multiple statements, markdown fences, or a trailing semicolon.
- Use ONLY tables/columns supplied and ONLY joins in the authoritative join list. If two desired objects have no listed path, do not invent one.
- Recheck every SELECT/GROUP BY/WHERE column against the alias/table that actually owns it.
- Use actual supplied data types. Explicitly cast textual numerics before arithmetic and textual dates before date math.
- Build analytical datasets, not raw table dumps. Derive useful business measures when the source fields genuinely support them.
- Prefer one primary dataset per report section so the saved HTML can rerender that section from one refreshed Excel sheet.
- Keep outputs stable and refresh-safe: deterministic column names, no data-dependent aliases, no hardcoded values observed from a sample.
- Do not terminate the SELECT with a semicolon and do not add a final ORDER BY; the report renderer performs presentation sorting and Studio wraps the SELECT for validation/result sampling.

For each section include its business question, analysis type and role in the story. Do NOT write rendering JavaScript yet. Respond ONLY with minified JSON matching:
{"views":[{"sheet_name":"ExcelSafe31Chars","view_name":"short_snake_case","purpose":"what business analysis this model supports","sql":"SELECT ...","columns":["exact_output_col1","exact_output_col2"]}],"sections":[{"view_name":"must match a view_name","title":"business-facing title","business_question":"question answered","analysis_type":"technique","story_role":"executive|driver|segment|trend|exception|detail","description":"what this section should communicate"}],"notes":"brief assumptions or limitations"}`;
  const userMsg = `Selected curated-view reporting scope and authoritative joins:\n${spSchemaSummaryWithJoinsText()}\n\nApproved report direction:\n${directionParts.join('\n\n')}`;
  const draft = await spCallOpenAI(sqlRules, userMsg, 0.2);
  if (!Array.isArray(draft.views) || !draft.views.length || !Array.isArray(draft.sections) || !draft.sections.length) throw new Error('Business-analysis pass did not return views and sections.');
  spGenerateStage = 'Normalising generated SQL…';
  renderAll();
  draft.views = await spPrepareGeneratedReportViews(draft.views);

  spGenerateStage = 'Validating SQL…';
  renderAll();
  spViewValidation = await spValidateViewList(draft.views);
  let failures = Object.entries(spViewValidation).filter(([,v])=>!v.ok);
  if(failures.length){
    spGenerateStage = `Repairing ${spSqlDialectLabel()} SQL…`;
    renderAll();
    const repaired=await spRepairReportViewsAfterTargetValidation(draft.views,spViewValidation);
    draft.views=repaired.views;spViewValidation=repaired.validation;
    failures=Object.entries(spViewValidation).filter(([,v])=>!v.ok);
  }
  if (failures.length){
    spGenerated = { views:draft.views, sections:draft.sections.map(s=>({...s,render_js:''})), notes:`The business-analysis plan was created, but ${failures.length} generated SQL view(s) still failed target validation after one automatic ${spSqlDialectLabel()} repair pass. Fix the SQL below, then regenerate the report.` };
    spGenerateStatus = 'error'; spGenerateStage = '';
    renderAll();
    throw new Error(`${failures.length} generated SQL view(s) failed validation after dialect repair: ${failures.map(([k,v])=>`${k}: ${v.error}`).join('; ')}`);
  }

  let samples = [];
  if (spResultAwareDesign){
    spGenerateStage = 'Reviewing live result samples…';
    renderAll();
    samples = await spCollectResultSamples(draft.views);
  }

  spGenerateStage = 'Designing business-ready report…';
  renderAll();
  const designRules = `You are a senior BI report designer and frontend analyst. The SQL datasets have already been validated. Design a polished, reusable, business-ready HTML analytical report from those datasets.

QUALITY BAR:
- Think like a consultant presenting to business users, not a chart generator.
- Establish clear visual hierarchy and analytical storytelling. The opening section should orient the reader with a strong executive summary or hero analysis when appropriate; later sections should explain drivers, segments/behaviour and exceptions/detail.
- Do not force the same layout into every section. Use the analytical technique that fits the business question: KPI strips, period variance, ranking bars, area/line trends, Pareto, funnels, cohort heatmaps, score bands, quadrants, timelines, relationship diagrams, waterfall-like bridges, compact detail tables, etc.
- The supplied live result samples are for choosing an effective design and understanding data shape. NEVER hardcode sample values, names, dates, insights or percentages into render_js. Every displayed value and every data-dependent sentence must be recalculated from the rows parameter so the SAME HTML remains correct when the workbook is refreshed months later.
- Explain important derived metrics and assumptions in concise business language. Dynamic insight text is encouraged when it is calculated from rows at render time.
- Detail tables support the story; they should normally be secondary/collapsible rather than dominating the page.

${SP_REPORT_STYLE_GUIDE}

RUNTIME TOOLBOX:
Each render_js is the BODY of a function receiving exactly rows, el and echarts. rows is an array of objects with the exact output columns declared for its view; el is an empty section container; echarts is Apache ECharts when the CDN loaded, otherwise it may be undefined. You may use HTML5, CSS Grid/Flexbox, DOM APIs, inline SVG and ECharts. Prefer ECharts for conventional charts and custom SVG/HTML when a bespoke business visual (timeline, cohort matrix, scorecard, journey) communicates better. If using ECharts, create a chart container inside el, check that echarts exists, initialise it with echarts.init(container), and give the container an explicit height. If ECharts is unavailable, keep the section useful with an HTML/SVG/table fallback rather than throwing. Do not access XLSX or fetch data. Do not assume any global except standard browser APIs and the passed echarts value.

ROBUSTNESS:
Treat spreadsheet cells as sparse/untrusted. Guard missing rows/elements, coerce numerics with Number(value)||0 where appropriate, parse dates defensively, handle empty datasets gracefully, and never throw because a filter has no matching rows. Any filter must recalculate the section in memory. Do not use eval/new Function inside render_js. Studio compiles render_js with new Function("rows", "el", "echarts", render_js) before the report can be downloaded. The string must be the function body only: no function declaration, no arrow-function wrapper, no markdown fence, and no extra } or ] after the last statement.

Return ONLY minified JSON matching:
{"sections":[{"view_name":"must match an existing dataset","title":"business-facing title","render_js":"JavaScript function body using rows, el, echarts"}],"notes":"2-4 sentences describing the analytical story and any important data limitations"}`;
  const designInput = {
    report_title:(spDashboardPlan&&spDashboardPlan.title)||'Business report',
    report_goal:(spDashboardPlan&&spDashboardPlan.report_goal)||'',
    planned_sections:draft.sections,
    datasets:draft.views.map(v=>({view_name:v.view_name,sheet_name:v.sheet_name,purpose:v.purpose||'',columns:v.columns||[]})),
    live_result_samples:spResultAwareDesign?samples:'NOT PROVIDED — design from dataset columns and blueprint only',
  };
  const designed = await spCallOpenAI(designRules, JSON.stringify(designInput), 0.35);
  if (!Array.isArray(designed.sections) || !designed.sections.length) throw new Error('Report-design pass did not return any sections.');
  const validViews = new Set(draft.views.map(v=>v.view_name));
  const badSection = designed.sections.find(sec=>!validViews.has(sec.view_name));
  if (badSection) throw new Error(`Report-design pass referenced unknown dataset "${badSection.view_name}".`);

  spGenerateStage = 'Checking section scripts…';
  renderAll();
  const sectionPrep = await spPrepareGeneratedReportSections(designed.sections, draft.views);

  spGenerated = {
    views:draft.views,
    sections:sectionPrep.sections,
    notes:[draft.notes, designed.notes].filter(Boolean).join(' '),
    report_title:(spDashboardPlan&&spDashboardPlan.title)||'Business report',
    report_goal:(spDashboardPlan&&spDashboardPlan.report_goal)||'',
    generation_mode:'business-ready',
  };
  spOverrides = {}; spExpanded = {}; spSectionOverrides = {};
  spViewValidation = await spValidateViewList(spGenerated.views);
  spRememberSectionValidation(sectionPrep.validation);
  const sectionFailures = Object.values(spSectionValidation).filter(result=>!result.ok);
  spGenerateStatus = sectionFailures.length ? 'error' : 'ok'; spGenerateStage = '';
  toast(sectionFailures.length
    ? `Datasets validated, but ${sectionFailures.length} section script(s) still failed JavaScript validation after one repair pass. Expand the failed section(s) before downloading HTML.`
    : `Generated business-ready report with ${spGenerated.views.length} live dataset(s) and ${spGenerated.sections.length} section(s).`,
    sectionFailures.length ? 'err' : 'ok');
  renderAll();
}

async function spGenerateStandardReport(){
  const includedSections = spDashboardPlan ? spDashboardPlan.sections.filter((s,i)=>spSectionsIncluded.has(i)) : [];
  const directionParts = [];
  if (includedSections.length){
    directionParts.push(`Build a single cohesive dashboard titled "${spDashboardPlan.title}" with these sections:\n` + includedSections.map(s=>`- ${s.name}: ${s.description}`).join('\n'));
  }
  if (spCustomDirection.trim()) directionParts.push('Additional direction from the person:\n' + spCustomDirection.trim());
  if (!directionParts.length){ toast('Get a dashboard suggestion first, or describe what you want, before generating.', 'err'); return; }
  spGenerateStatus = 'loading';
  renderAll();
  // Note on architecture: earlier versions of this asked the model to write
  // one giant self-contained HTML report (file-loading, sheet-parsing, all
  // of it) in a single JSON string. That gave the model too much surface
  // area, and nothing verified afterward that the report's parsing logic
  // actually agreed with the workbook it also described — a two-file
  // consistency problem with no check on it. Now the app itself owns the
  // shell (file loading, sheet parsing by the exact sheet_name/columns
  // below, branding, layout) — see spBuildReportHtml() — and the model is
  // only asked for one small, verifiable thing per section: given rows
  // already parsed into objects with known keys, render into a container.
  const rules = `You are a senior BI engineer. You are given a selected curated-dataset reporting scope (view and column names) and a description of the dashboard a business user wants. Use ONLY the selected business models supplied. Produce:
1. A small number of plain ${spSqlDialectLabel()} reporting queries. ${spSqlDialectPromptRules()} Every views[].sql must be EXACTLY ONE SELECT (or WITH … SELECT) statement with no SET/DECLARE/temp-table setup, no DDL/DML, no markdown fence, no second statement and no trailing semicolon. Do not use CREATE VIEW; return only the SELECT body — over the selected business models. If a query needs to join selected views, use ONLY the join list given below (each line names the two tables and the exact column to join them on) — that list is complete and authoritative, so if two tables you want to relate aren't in it, there is no direct join between them and you must go through whatever table does connect them, not guess a join condition of your own. Never invent a column or table name that was not given to you. If a join you set up doesn't end up feeding any output column, remove it rather than leaving it in unused. The schema gives each column's actual data type. Never call SUM/AVG or do numeric math on text without an explicit dialect-correct numeric cast, and cast date/timestamp-like text before date math.
2. For each view: a short sheet_name (Excel-safe, 31 characters or fewer, no spaces), a short_snake_case view_name, and the exact list of output column names it returns, in order. Before finishing, check every column reference in SELECT/GROUP BY/WHERE against the column list given for whichever table its alias actually points to — this has been the single most common mistake so far (e.g. writing s.some_column when s is aliased to a table that was never given that column).
3. One dashboard section per view (or per logical group of related views), each with a title and a render_js string. render_js is the BODY of a function — not the function declaration, just the statements inside it — and Studio rejects the section unless new Function("rows", "el", "echarts", render_js) parses. Do not wrap the body in a function or arrow function, do not use a markdown fence, and do not leave an extra } or ] after the last statement. The body receives two parameters named exactly rows and el: rows is a plain JavaScript array of row objects already parsed from the matching sheet (each object's keys are exactly the columns list you gave for that view — the app has already handled file loading and sheet parsing, you never need to touch XLSX/file APIs at all), and el is an empty DOM element already in the page for you to render into by setting el.innerHTML. Every section must, inside its render_js:
   a. Compute and render a row of KPI stat cards from rows in plain JavaScript (total, average, count, min/max — whichever are meaningful for that view's actual columns). This is the first thing rendered, not an afterthought.
   b. Render at least one chart, unless rows has no numeric measure to aggregate at all. Pick the chart from the data shape actually present in rows: a time-like column + a measure → bar/line over time; one category column + a measure → a ranked bar chart; two category columns + a measure → an actual pivot (group rows by both categories in JavaScript, render as a table with the first category as rows and the second as columns, cells = aggregated measure — not just the flat rows relabeled). Build the chart as inline SVG markup assigned into el.innerHTML alongside the rest of the section — no charting library exists in this page, so write the SVG string yourself the same way you'd build any other HTML string. The chart is the main output of the section; the raw table is secondary.
   c. Render the detail rows last and collapsed by default (e.g. behind a <details> element or a toggle button), never as the first or only thing shown.
   d. Add at least one working interactive filter appropriate to that section's actual columns — a date range if there's a date-like column, and/or a dropdown built from the distinct values actually present in rows (never invented) for whichever category column is most relevant. The filter must actually work: changing it must re-run your grouping/aggregation over rows (in memory, no reload) and update that section's KPIs, chart, and table in place. Skip this only if the section genuinely has no sensible filter dimension.
   Everything you do — KPI math, grouping, pivoting, chart SVG, filter wiring, DOM updates — must be built with plain JavaScript and DOM APIs only inside render_js; there is no other script, library, or global available to you besides rows, el, and standard browser JavaScript. Real spreadsheets are frequently sparse — treat every cell value as possibly missing, blank, or the wrong type, and code defensively throughout: never read a property off the result of array.find/filter/querySelector/getElementById without first checking that result isn't undefined or null; when converting a cell value to a number, use something like (Number(row.someColumn) || 0) rather than assuming it's already numeric; when grouping or building a dropdown's options, skip or bucket rows where the grouping column is blank rather than letting them throw. A section should degrade to showing fewer rows or a "no data for this filter" message, never throw an uncaught error the person can't do anything about.
${SP_REPORT_STYLE_GUIDE}
Respond with ONLY minified JSON, no prose, no markdown fences, matching exactly this shape:
{"views":[{"sheet_name":"...","view_name":"...","sql":"SELECT ...","columns":["col1","col2"]}],"sections":[{"view_name":"...","title":"...","render_js":"var total = rows.reduce(...); el.innerHTML = ...;"}],"notes":"2-3 plain-English sentences on what was built and anything to know before using it"}`;
  const userMsg = `Selected curated-view reporting scope (table_or_view(column:data_type, ...)):\n${spSchemaSummaryWithJoinsText()}\n\n${directionParts.join('\n\n')}`;
  try {
    const parsed = await spCallOpenAI(rules, userMsg, 0.2);
    if (!Array.isArray(parsed.views) || !Array.isArray(parsed.sections) || !parsed.sections.length) throw new Error('Model response was missing views or sections.');
    parsed.views = await spPrepareGeneratedReportViews(parsed.views);
    parsed.report_title=(spDashboardPlan&&spDashboardPlan.title)||parsed.report_title||'Business report';
    const sectionPrep=await spPrepareGeneratedReportSections(parsed.sections, parsed.views);
    parsed.sections=sectionPrep.sections;
    spOverrides = {}; spExpanded = {}; spSectionOverrides = {};
    let validation=await spValidateViewList(parsed.views);
    if(Object.values(validation).some(v=>!v.ok)){
      const repaired=await spRepairReportViewsAfterTargetValidation(parsed.views,validation);
      parsed.views=repaired.views;validation=repaired.validation;
    }
    spGenerated = parsed;spViewValidation=validation;
    spRememberSectionValidation(sectionPrep.validation);
    const failed=Object.values(validation).filter(v=>!v.ok).length;
    const sectionFailed=Object.values(spSectionValidation).filter(v=>!v.ok).length;
    spGenerateStatus = (failed||sectionFailed)?'error':'ok';
    const problems=[];
    if(failed)problems.push(`${failed} generated SQL view(s) still failed ${spSqlDialectLabel()} validation after one automatic repair pass`);
    if(sectionFailed)problems.push(`${sectionFailed} section script(s) still failed JavaScript validation after one repair pass`);
    toast(problems.length?`${problems.join('; ')}.`:`Generated ${parsed.views.length} view(s) across ${parsed.sections.length} section(s); SQL and section scripts validated.`,problems.length?'err':'ok');
    renderAll();
    return;
  } catch(err){
    spGenerateStatus = 'error';
    toast('Could not generate the report: ' + err.message, 'err');
  }
  renderAll();
}

async function spGenerateReport(){
  if (spGenerateStatus === 'loading') return;
  if (!spSelectedSchemaTables().length){ toast('Select at least one business model for reporting first.', 'err'); return; }
  const includedSections = spDashboardPlan ? spDashboardPlan.sections.filter((s,i)=>spSectionsIncluded.has(i)) : [];
  const directionParts = [];
  if (includedSections.length){
    directionParts.push(`Build a single cohesive report titled "${spDashboardPlan.title}" with these sections:\n` + includedSections.map(s=>`- ${s.name}${s.business_question?` — ${s.business_question}`:''}: ${s.description}`).join('\n'));
  }
  if (spCustomDirection.trim()) directionParts.push('Additional direction from the person:\n' + spCustomDirection.trim());
  if (!directionParts.length){ toast('Get a report suggestion first, or describe what you want, before generating.', 'err'); return; }
  if (!spBusinessReady) return spGenerateStandardReport();
  spGenerateStatus = 'loading'; spGenerateStage = 'Planning analytical datasets…'; spGenerated = null;
  spOverrides = {}; spExpanded = {}; spSectionOverrides = {}; spViewValidation = {}; spSectionValidation = {};
  renderAll();
  try {
    await spGenerateBusinessReadyReport(directionParts);
  } catch(err){
    spGenerateStatus = 'error'; spGenerateStage = '';
    toast('Could not generate the business-ready report: ' + err.message, 'err');
    renderAll();
  }
}

// Builds (or refreshes, if existingWb is passed) the workbook by actually
// running each view's SQL against the connected vault, via the same
// single-SELECT-only /api/query endpoint introspection already uses — no
// server changes needed, since every generated view is exactly that: one
// plain SELECT. Per-view failures are collected rather than aborting the
// whole workbook, so one bad view doesn't block the rest.
async function spBuildWorkbookLive(existingWb){
  const wb = existingWb || XLSX.utils.book_new();
  const instructions = [['Sheet', 'SQL used to populate this sheet (kept for reference / manual re-run elsewhere)']];
  const errors = [];
  for (const v of spViewsWithExcelSheetNames(spGenerated.views||[])){
    const sheetName = v.sheet_name;
    const sql = spGetViewSql(v);
    let rows = [];
    try {
      rows = await spQuery(sql);
    } catch(err){
      errors.push(`${sheetName}: ${err.message}`);
    }
    const header = (v.columns && v.columns.length) ? v.columns : (rows[0] ? Object.keys(rows[0]) : ['column1']);
    const aoa = [header, ...rows.map(r=>header.map(h=> r[h]!==undefined && r[h]!==null ? r[h] : ''))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (existingWb && existingWb.Sheets[sheetName]){
      existingWb.Sheets[sheetName] = ws; // overwrite in place, leave any other sheets in the file untouched
    } else {
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }
    instructions.push([sheetName, sql]);
  }
  const instrWs = XLSX.utils.aoa_to_sheet(instructions);
  if (existingWb && existingWb.Sheets['Instructions']) existingWb.Sheets['Instructions'] = instrWs;
  else if (!existingWb) XLSX.utils.book_append_sheet(wb, instrWs, 'Instructions');
  return { wb, errors };
}

async function spDownloadWorkbook(){
  if (!spGenerated) return;
  const btn = document.getElementById('btn-sp-dl-excel');
  if (btn){ btn.disabled = true; btn.textContent = 'Running queries…'; }
  try {
    const { wb, errors } = await spBuildWorkbookLive();
    XLSX.writeFile(wb, `${spReportFilenameBase()}.xlsx`, { bookType: 'xlsx' });
    toast(errors.length ? `Downloaded, but ${errors.length} view(s) failed to run — see toast log / Instructions sheet.` : 'Workbook downloaded with live data.', errors.length?'err':'ok');
    errors.forEach(e=>toast(e,'err'));
  } catch(err){
    toast('Could not build the workbook: ' + err.message, 'err');
  }
  if (btn){ btn.disabled = false; btn.textContent = '↻ Rerun SQL & download Excel'; }
}

async function spRefreshUploadedWorkbook(file){
  if (!spGenerated) return;
  const statusEl = document.getElementById('sp-refresh-status');
  if (statusEl) statusEl.innerHTML = `<div class="ai-status busy mt"><span class="dot"></span>Refreshing…</div>`;
  try {
    const data = await file.arrayBuffer();
    const existingWb = XLSX.read(data, { type:'array' });
    const { errors } = await spBuildWorkbookLive(existingWb);
    const outName = file.name.replace(/\.xlsx?$/i,'') + '_refreshed.xlsx';
    XLSX.writeFile(existingWb, outName, { bookType:'xlsx' });
    if (statusEl) statusEl.innerHTML = errors.length
      ? `<div class="ai-status err mt">Refreshed and downloaded as ${escapeHtml(outName)}, but ${errors.length} view(s) failed: ${errors.map(escapeHtml).join('; ')}</div>`
      : `<div class="ai-status ok mt">Refreshed — downloaded as ${escapeHtml(outName)}.</div>`;
  } catch(err){
    if (statusEl) statusEl.innerHTML = `<div class="ai-status err mt">Could not refresh that file: ${escapeHtml(err.message)}</div>`;
  }
}
