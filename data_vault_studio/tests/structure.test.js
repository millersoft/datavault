'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { listLocalScripts } = require('./helpers/load-app');
const { createApp } = require('../server/app');

const studioDir = path.resolve(__dirname, '..');

function routeInventory(app){
  const routes=[];
  function visit(stack){
    for(const layer of stack||[]){
      if(layer.route){
        const method=Object.keys(layer.route.methods).find(key=>layer.route.methods[key]);
        routes.push(`${method.toUpperCase()} ${layer.route.path}`);
      }else if(layer.handle&&Array.isArray(layer.handle.stack)) visit(layer.handle.stack);
    }
  }
  visit(app._router.stack);
  return routes;
}

describe('modular frontend shell',()=>{
  test('index.html owns markup and asset order, not application implementation',()=>{
    const htmlPath=path.join(studioDir,'public','index.html');
    const html=fs.readFileSync(htmlPath,'utf8');
    assert.doesNotMatch(html,/<style\b/i);
    const inline=[...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match=>match[1].trim()).filter(Boolean);
    assert.deepStrictEqual(inline,["const STUDIO_RUNTIME_MODE = '__STUDIO_RUNTIME_MODE__' === 'demo' ? 'demo' : 'production';"]);
    const local=listLocalScripts(htmlPath).filter(script=>script.type==='local');
    assert.ok(local.length>=40,`expected feature files, found ${local.length}`);
    for(const script of local)assert.doesNotThrow(()=>new Function(script.source),script.filename);
  });

  test('source extraction, staging base tables and staging views have separate owners',()=>{
    for(const relative of [
      'public/js/generators/source-extract-sql.js',
      'public/js/generators/staging-base-ddl.js',
      'public/js/generators/staging-view-ddl.js',
    ]) assert.ok(fs.existsSync(path.join(studioDir,relative)),relative);
  });

  test('the former HTML God file is gone',()=>{
    assert.ok(!fs.existsSync(path.join(studioDir,'millersoft_vault_studio.html')));
  });
});

describe('modular companion server',()=>{
  test('startup and app assembly stay small and contain no API business handlers',()=>{
    const startup=fs.readFileSync(path.join(studioDir,'server.js'),'utf8');
    const assembly=fs.readFileSync(path.join(studioDir,'server','app.js'),'utf8');
    assert.ok(startup.split('\n').length<30);
    assert.ok(assembly.split('\n').length<180);
    assert.doesNotMatch(startup,/\.get\(|\.post\(|\.delete\(/);
    assert.doesNotMatch(assembly,/app\.(?:get|post|delete)\('\/api\//);
  });

  test('all 45 API endpoints are registered exactly once through routers',()=>{
    const routes=routeInventory(createApp());
    const apiRoutes=routes.filter(route=>route.includes(' /api/'));
    assert.strictEqual(apiRoutes.length,45);
    assert.strictEqual(new Set(apiRoutes).size,45);
  });

  test('route ownership is split by feature',()=>{
    for(const name of ['system','database-packs','source','target','external-target','workspace','environment','license','engine','scheduler']){
      assert.ok(fs.existsSync(path.join(studioDir,'server','routes',`${name}.js`)),name);
    }
    assert.ok(fs.existsSync(path.join(studioDir,'server','database','source.js')));
    assert.ok(fs.existsSync(path.join(studioDir,'server','database-packs','index.js')));
  });
});
