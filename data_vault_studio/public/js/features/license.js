/* =========================================================================
   LICENSE — the engine stack refuses to start until the product license is
   accepted (start.sh / start.ps1 gate on a hash marker). Instead of sending
   people to a terminal, the GUI shows the license on first load and offers
   explicit acceptance; the server writes the same marker the scripts write.
   No license file / no server = nothing shown (start.sh still enforces).
   ========================================================================= */
let licenseState = null; // null = not checked | { exists, accepted, text }

async function refreshLicenseState(){
  try {
    const r = await localFetch('/api/license');
    const data = await r.json();
    licenseState = data.ok ? data : null;
  } catch(_){ licenseState = null; } // server not running — start.sh will enforce
  return licenseState;
}

function showMissingEnvModal(){
  if (document.getElementById('env-missing-modal-backdrop')) return;
  const wrap = document.createElement('div');
  wrap.id = 'env-missing-modal-backdrop';
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal-card" style="max-width:620px;">
      <h3 style="font-family:var(--font-display);font-size:15px;margin:0 0 4px;">Configuration required</h3>
      <p class="section-desc" style="margin-bottom:10px;">Data Vault Studio could not find the required <span class="mono">.env</span> configuration file.</p>
      <p>Configure the provided <span class="mono">.env.example</span> file and save it as <span class="mono">.env</span> before continuing.</p>
      <div id="env-missing-modal-err"></div>
      <div class="mt" style="display:flex;justify-content:flex-end;">
        <button class="btn primary" id="env-check-again">Check again</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  document.getElementById('env-check-again').addEventListener('click', async ()=>{
    const btn = document.getElementById('env-check-again');
    const errorBox = document.getElementById('env-missing-modal-err');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    errorBox.innerHTML = '';
    await refreshEnvDefaults();

    if (envFileStatus && envFileStatus.ok && envFileStatus.found){
      wrap.remove();
      toast('Configuration file found.', 'ok');
      await refreshLicenseState();
      if (licenseState && licenseState.exists && !licenseState.accepted) showLicenseModal();
      return;
    }

    btn.disabled = false;
    btn.textContent = 'Check again';
    const message = envFileStatus && envFileStatus.found
      ? (envFileStatus.error || 'The .env file exists but could not be read.')
      : envFileStatus
        ? '.env is still missing. Create the file and try again.'
        : 'Could not reach the local Studio server. Check the npm start output and try again.';
    errorBox.innerHTML = `<div class="ai-status err mt">${escapeHtml(message)}</div>`;
  });
}

function showLicenseModal(onAccepted){
  if (document.getElementById('license-modal-backdrop')) return;
  const wrap = document.createElement('div');
  wrap.id = 'license-modal-backdrop';
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal-card" style="max-height:85vh;overflow:auto;max-width:760px;">
      <h3 style="font-family:var(--font-display);font-size:15px;margin:0 0 4px;">License agreement</h3>
      <p class="section-desc" style="margin-bottom:10px;">Accept once to enable the engine and packaged containers. Recorded next to the project (same marker the start scripts write).</p>
      <pre class="mono" style="white-space:pre-wrap;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;max-height:45vh;overflow:auto;font-size:12px;">${escapeHtml((licenseState && licenseState.text) || '')}</pre>
      <div id="license-modal-err"></div>
      <div class="mt" style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="btn ghost" id="license-decline">Not now</button>
        <button class="btn primary" id="license-accept">Accept license</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  document.getElementById('license-decline').addEventListener('click', ()=> wrap.remove());
  document.getElementById('license-accept').addEventListener('click', async ()=>{
    const btn = document.getElementById('license-accept');
    btn.disabled = true; btn.textContent = 'Accepting…';
    try {
      const r = await localFetch('/api/license-accept', { method:'POST',
        headers:{'Content-Type':'application/json'}, body: JSON.stringify({ accept: true }) }).then(x=>x.json());
      if (!r.ok) throw new Error(r.error || 'Could not record acceptance.');
      licenseState = Object.assign({}, licenseState, { accepted: true });
      wrap.remove();
      toast('License accepted.', 'ok');
      if (onAccepted) onAccepted();
    } catch(err){
      btn.disabled = false; btn.textContent = 'Accept license';
      document.getElementById('license-modal-err').innerHTML = `<div class="ai-status err mt">${escapeHtml(err.message)}</div>`;
    }
  });
}

// Gate for anything that starts the stack. Returns true when clear to
// proceed; otherwise opens the modal (retrying the action on acceptance).
async function requireLicenseAccepted(retry){
  await refreshLicenseState();
  if (!licenseState || !licenseState.exists || licenseState.accepted) return true;
  showLicenseModal(retry);
  return false;
}

// First-load gates: the root .env must exist before Studio can be used. Once
// configuration is present, offer license acceptance before engine startup.
(async ()=>{
  await refreshEnvDefaults();
  if (envFileStatus && envFileStatus.ok && !envFileStatus.found){
    showMissingEnvModal();
    return;
  }
  await refreshLicenseState();
  if (licenseState && licenseState.exists && !licenseState.accepted) showLicenseModal();
})();

renderAll();
loadDatabasePacks().then(()=>{ if(!isDemoRuntime()){ enforceRuntimeConnections(false); renderAll(); } });
detectDbInitPath(); // known before the person ever needs a folder path, regardless of which tab they visit first
maybeOfferAutosaveRestore();

