function resolveStudioMode(argv = process.argv.slice(2), env = process.env){
  let requested = '';
  for (let i = 0; i < argv.length; i++){
    const arg = String(argv[i] || '');
    if (arg.startsWith('--mode=')) requested = arg.slice('--mode='.length);
    else if (arg === '--mode' && argv[i + 1]) requested = String(argv[++i]);
  }
  const mode = (requested || env.STUDIO_MODE || 'production').trim().toLowerCase();
  if (!['demo', 'production'].includes(mode)){
    throw new Error(`Invalid Studio mode "${mode}". Use --mode=demo or --mode=production.`);
  }
  return mode;
}

function resolvePort(env = process.env){ return env.PORT || 8420; }

module.exports = { resolveStudioMode, resolvePort };
