/* =========================================================================
   EXPORT TAB
   ========================================================================= */
let exportExpanded = { staging:false, datavault:false, pdimeta:false, remotetables:false };
let exportOverrides = { staging:null, datavault:null, pdimeta:null, remotetables:null };
const EXPORT_BUILDERS = {
  staging: buildStagingDdl,
  datavault: buildDataVaultDdl,
  pdimeta: buildPdiMetaSql,
  remotetables: () => buildExternalTablesDdl(),
};
const EXPORT_FILENAMES = {
  staging: () => `${state.vault.name||'vault'}_staging_ddl.sql`,
  datavault: () => `${state.vault.name||'vault'}_data_vault_ddl.sql`,
  pdimeta: () => `${state.vault.name||'vault'}_metadata.sql`,
  remotetables: () => `${state.vault.name||'vault'}_remote_table_ddl.sql`,
};
// Edited content (if any) is used in place of the freshly generated SQL for
// download/execute/preview, until explicitly reset — this is what makes the
// per-file preview below an actual editor rather than a read-only dump.
function getExportSql(key){
  return exportOverrides[key] != null ? exportOverrides[key] : EXPORT_BUILDERS[key]();
}
function exportFileRowHtml(key, label, hintHtml, canRun){
  const expanded = !!exportExpanded[key];
  const edited = exportOverrides[key] != null;
  return `
    <div class="export-file-row ${expanded?'expanded':''}">
      <div class="export-file-row-head">
        <button class="export-file-toggle" data-toggle="${key}" aria-expanded="${expanded}">
          <span class="export-file-caret">${expanded?'▾':'▸'}</span>
          <span class="export-file-label">${label}</span>
          <span class="hint">(${hintHtml})</span>
          ${edited ? `<span class="badge-count">edited</span>` : ''}
        </button>
        <div class="export-file-actions">
          <button class="btn small" data-dl="${key}">⬇ Download</button>
          ${canRun ? `<button class="btn small" data-run="${key}">Execute</button>` : ''}
        </div>
      </div>
      ${expanded ? `
      <div class="export-file-body">
        <textarea class="code-edit" data-editor="${key}" spellcheck="false" wrap="off">${escapeHtml(getExportSql(key))}</textarea>
        <div class="export-file-body-actions">
          <p class="hint mb0">${edited ? 'Edited — this version will be used for download and execute.' : 'Generated from the current model — edit above to override it.'}</p>
          ${edited ? `<button class="btn small ghost" data-reset="${key}">Reset to generated</button>` : ''}
        </div>
      </div>` : ''}
    </div>`;
}

