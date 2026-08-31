'use strict';

function registerSchedulerRoutes(parentApp, dependencies){
  const {
    express,
    fs,
    path,
    PROJECT_ROOT,
    ENGINE_MODES,
    runFixedCommand,
  } = dependencies;
  const app = express.Router();

  const SCHEDULER_STATE_PATH = path.join(PROJECT_ROOT, '.vault-studio-scheduler.json');
  const SCHEDULER_LOG_LIMIT = 25;
  let schedulerState = {
    enabled: false,
    intervalMinutes: 60,
    mode: 'internal',
    nextRunAt: null,
    lastRunAt: null,
    log: [],
  };

  function loadSchedulerState(){
    try {
      const raw = fs.readFileSync(SCHEDULER_STATE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      schedulerState = { ...schedulerState, ...parsed };
    } catch(_) { /* no persisted state yet, or unreadable — start fresh */ }
  }
  function saveSchedulerState(){
    try { fs.writeFileSync(SCHEDULER_STATE_PATH, JSON.stringify(schedulerState, null, 2)); }
    catch(_) { /* best-effort — a failed save shouldn't crash a scheduled run */ }
  }
  function schedulerLog(entry){
    schedulerState.log.unshift({ at: new Date().toISOString(), ...entry });
    schedulerState.log = schedulerState.log.slice(0, SCHEDULER_LOG_LIMIT);
  }
  async function runSchedulerNow(reason){
    schedulerState.lastRunAt = new Date().toISOString();
    const args = ENGINE_MODES[schedulerState.mode] || ENGINE_MODES.internal; // never --build on a schedule
    const result = await runFixedCommand(args, 120000);
    schedulerLog({ ok: result.ok, reason, error: result.ok ? undefined : (result.error || 'Failed — see server logs.') });
    if (schedulerState.enabled){
      schedulerState.nextRunAt = new Date(Date.now() + schedulerState.intervalMinutes * 60000).toISOString();
    }
    saveSchedulerState();
    return result;
  }
  loadSchedulerState();
  // Checked every 15s rather than computing a precise setTimeout for the
  // exact due time — simpler, self-correcting if the process was asleep or
  // paused (e.g. a laptop lid closed), and 15s of jitter on an hourly-or-
  // longer schedule is never going to matter.
  const schedulerInterval = setInterval(() => {
    if (!schedulerState.enabled || !schedulerState.nextRunAt) return;
    if (new Date(schedulerState.nextRunAt).getTime() <= Date.now()){
      runSchedulerNow('scheduled').catch(()=>{});
    }
  }, 15000);
  schedulerInterval.unref();
  
  app.get('/api/scheduler/status', (req, res) => {
    res.json({ ok: true, ...schedulerState });
  });
  
  app.post('/api/scheduler/config', (req, res) => {
    const { enabled, intervalMinutes, mode } = req.body || {};
    if (intervalMinutes != null){
      const n = Number(intervalMinutes);
      if (!Number.isFinite(n) || n < 1) return res.status(400).json({ ok:false, error:'intervalMinutes must be a number of 1 or more.' });
      schedulerState.intervalMinutes = n;
    }
    if (mode != null){
      if (!Object.prototype.hasOwnProperty.call(ENGINE_MODES, mode)) {
        return res.status(400).json({ ok:false, error:`Unknown engine mode "${mode}" — allowed: ${Object.keys(ENGINE_MODES).join(', ')}.` });
      }
      schedulerState.mode = mode;
    }
    if (enabled != null){
      schedulerState.enabled = !!enabled;
      schedulerState.nextRunAt = schedulerState.enabled
        ? new Date(Date.now() + schedulerState.intervalMinutes * 60000).toISOString()
        : null;
    }
    saveSchedulerState();
    res.json({ ok: true, ...schedulerState });
  });
  
  app.post('/api/scheduler/run-now', async (req, res) => {
    const result = await runSchedulerNow('manual');
    res.json({ ok: true, result, ...schedulerState });
  });
  
  parentApp.use(app);
}

module.exports = { registerSchedulerRoutes };
