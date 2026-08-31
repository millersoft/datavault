/* =========================================================================
   Rendering shell
   ========================================================================= */
const TABS = [
  { id:'connections', label:'1 · Connections' },
  { id:'tables', label:'2 · Tables' },
  { id:'staging', label:'3 · Staging' },
  { id:'vault', label:'4 · Vault' },
  { id:'export', label:'5 · Export' },
];
let activeTab = 'connections';

function scrollPageToTop(){
  // The application scrolls inside <main>, not the document. Reset both the
  // real scroll container and the document so every explicit wizard-step
  // navigation opens at the destination heading. Repeat after the next paint
  // because the clicked footer button is removed during renderAll().
  const reset = ()=>{
    const main = document.getElementById('main');
    if (main){
      main.scrollTop = 0;
      main.scrollLeft = 0;
      if (typeof main.scrollTo === 'function') main.scrollTo(0, 0);
    }
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    if (document.documentElement) document.documentElement.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
    if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') window.scrollTo(0, 0);
  };
  reset();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reset);
}

function navigateDesignerTab(tab){
  activeTab = tab;
  renderAll();
  scrollPageToTop();
}

function renderTabs(){
  const tabsEl = document.getElementById('tabs');
  tabsEl.innerHTML = TABS.map(t=>{
    let count = '';
    if (t.id==='tables') count = state.tables.length;
    if (t.id==='staging') count = state.tables.filter(t=>t.included!==false).length;
    if (t.id==='vault') count = state.hubs.length + state.links.length + state.hubSats.length + state.linkSats.length;
    return `<button class="tab-btn ${activeTab===t.id?'active':''}" data-tab="${t.id}">
      ${t.label}${count!==''?`<span class="tab-count">${count}</span>`:''}
    </button>`;
  }).join('');
  tabsEl.querySelectorAll('.tab-btn').forEach(b=>{
    b.addEventListener('click', ()=>{
      const nextTab = b.dataset.tab;
      if ((nextTab==='vault' || nextTab==='export') && !stagingHashColumnsReady()){
        navigateDesignerTab('staging');
        toast(stagingHashRequirementMessage(), 'err');
        return;
      }
      navigateDesignerTab(nextTab);
    });
  });
}

let appMode = 'landing'; // 'landing' | 'designer' | 'dashboard' | 'studioplus'

function renderAll(){
  const modeSwitchEl = document.getElementById('mode-switch');
  const projectActionsEl = document.getElementById('topbar-project-actions');
  const tabsEl = document.getElementById('tabs');
  const main = document.getElementById('main');

  if (appMode==='landing'){
    modeSwitchEl.style.display = 'none';
    projectActionsEl.style.display = 'none';
    tabsEl.style.display = 'none';
    tabsEl.innerHTML = '';
    main.innerHTML = `<div id="landing-root"></div>`;
    renderLanding(document.getElementById('landing-root'));
    return;
  }
  modeSwitchEl.style.display = '';
  projectActionsEl.style.display = '';
  document.getElementById('mode-home').classList.remove('active');
  document.getElementById('mode-designer').classList.toggle('active', appMode==='designer');
  document.getElementById('mode-dashboard').classList.toggle('active', appMode==='dashboard');
  document.getElementById('mode-studioplus').classList.toggle('active', appMode==='studioplus');
  if (appMode==='dashboard'){
    tabsEl.style.display = 'none';
    tabsEl.innerHTML = '';
    main.innerHTML = `<div id="dashboard-root"></div>`;
    renderDashboard(document.getElementById('dashboard-root'));
    return;
  }
  if (appMode==='studioplus'){
    tabsEl.style.display = 'none';
    tabsEl.innerHTML = '';
    main.innerHTML = `<div id="studioplus-root"></div>`;
    renderStudioPlus(document.getElementById('studioplus-root'));
    return;
  }
  tabsEl.style.display = '';
  renderTabs();
  main.innerHTML = `
    <div class="view ${activeTab==='connections'?'active':''}" id="view-connections"></div>
    <div class="view ${activeTab==='tables'?'active':''}" id="view-tables"></div>
    <div class="view ${activeTab==='staging'?'active':''}" id="view-staging"></div>
    <div class="view ${activeTab==='vault'?'active':''}" id="view-vault"></div>
    <div class="view ${activeTab==='export'?'active':''}" id="view-export"></div>
    <div id="ai-modal-mount"></div>
  `;
  if (activeTab==='connections') renderConnections(document.getElementById('view-connections'));
  if (activeTab==='tables') renderTables(document.getElementById('view-tables'));
  if (activeTab==='staging') renderStaging(document.getElementById('view-staging'));
  if (activeTab==='vault') renderVault(document.getElementById('view-vault'));
  if (activeTab==='export') renderExport(document.getElementById('view-export'));
}
document.getElementById('mode-home').addEventListener('click', ()=>{ stopSchedulerPolling(); appMode='landing'; renderAll(); });
document.getElementById('mode-designer').addEventListener('click', ()=>{ stopSchedulerPolling(); appMode='designer'; renderAll(); });
document.getElementById('mode-dashboard').addEventListener('click', ()=>{ appMode='dashboard'; renderAll(); });
document.getElementById('mode-studioplus').addEventListener('click', ()=>{ stopSchedulerPolling(); appMode='studioplus'; renderAll(); });

function renderLanding(el){
  el.innerHTML = `
    <div class="landing-wrap">
      <h1 class="landing-title">Data Vault Studio</h1>
      <p class="landing-sub">Design a Data Vault 2.0 model from a real source schema, generate its DDL and metadata spreadsheet, and deploy or run it — all from one place.</p>
      <div class="landing-cards">
        <button class="landing-card" id="landing-new">
          <div class="landing-card-icon">+</div>
          <div class="landing-card-title">New project</div>
          <p class="landing-card-desc">Start a fresh design — connections, tables, hubs, links, and satellites, step by step.</p>
        </button>
        <button class="landing-card" id="landing-edit">
          <div class="landing-card-icon">✎</div>
          <div class="landing-card-title">Edit existing project</div>
          <p class="landing-card-desc">Load a previously saved project file and pick up exactly where you left off.</p>
        </button>
        <button class="landing-card" id="landing-hub">
          <div class="landing-card-icon">▤</div>
          <div class="landing-card-title">Data Vault Hub</div>
          <p class="landing-card-desc">Run history, load metrics, and engine controls for a vault that's already deployed.</p>
        </button>
        <button class="landing-card" id="landing-studioplus">
          <div class="landing-card-icon">★</div>
          <div class="landing-card-title">Data Vault Studio Plus</div>
          <p class="landing-card-desc">AI-assisted reporting — connect to a deployed vault and generate SQL, an Excel workbook, and an HTML report.</p>
        </button>
      </div>
    </div>`;
  document.getElementById('landing-new').addEventListener('click', ()=> startNewProject(true));
  document.getElementById('landing-edit').addEventListener('click', ()=> document.getElementById('file-load-project').click());
  document.getElementById('landing-hub').addEventListener('click', ()=>{ appMode='dashboard'; renderAll(); });
  document.getElementById('landing-studioplus').addEventListener('click', ()=>{ appMode='studioplus'; renderAll(); });
}

