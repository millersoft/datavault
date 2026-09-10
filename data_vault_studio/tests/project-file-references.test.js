const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  HOP_CERTS_ROOT,
  resolveHostCertificateReferences,
  resolveContainerCertificateReferences,
} = require('../server/project-file-references');
const { createProjectPaths } = require('../server/config/project-paths');

describe('project-managed JDBC certificate references',()=>{
  test('resolves portable dv-certs references differently for Studio and Hop',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'dvs-certs-'));
    fs.mkdirSync(path.join(root,'dv-certs'),{recursive:true});
    const value='jdbc:postgresql://db:5432/source?sslrootcert=dv-certs/ca.pem&sslmode=verify-full';
    const host=resolveHostCertificateReferences(value,root);
    const hop=resolveContainerCertificateReferences(value);
    assert.strictEqual(host,`jdbc:postgresql://db:5432/source?sslrootcert=${path.join(root,'dv-certs','ca.pem')}&sslmode=verify-full`);
    assert.strictEqual(hop,`jdbc:postgresql://db:5432/source?sslrootcert=${HOP_CERTS_ROOT}/ca.pem&sslmode=verify-full`);
    fs.rmSync(root,{recursive:true,force:true});
  });

  test('does not pre-check certificate existence; the JDBC driver owns connection validation',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'dvs-certs-'));
    fs.mkdirSync(path.join(root,'dv-certs'),{recursive:true});
    const resolved=resolveHostCertificateReferences('dv-certs/not-created.pem',root);
    assert.strictEqual(resolved,path.join(root,'dv-certs','not-created.pem'));
    assert.strictEqual(fs.existsSync(resolved),false);
    fs.rmSync(root,{recursive:true,force:true});
  });

  test('rejects traversal and symlink escapes rather than widening Studio filesystem access',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'dvs-certs-'));
    const certs=path.join(root,'dv-certs');
    fs.mkdirSync(certs,{recursive:true});
    assert.throws(()=>resolveHostCertificateReferences('dv-certs/../secret.txt',root),/parent-directory/);
    assert.throws(()=>resolveContainerCertificateReferences('file:dv-certs/../../secret.txt'),/parent-directory/);
    const outside=path.join(root,'outside.pem');
    fs.writeFileSync(outside,'not a certificate');
    const link=path.join(certs,'linked.pem');
    try {
      fs.symlinkSync(outside,link);
      assert.throws(()=>resolveHostCertificateReferences('dv-certs/linked.pem',root),/symbolic links/);
    } catch (err) {
      // Some Windows/test environments do not grant symlink creation. Only
      // suppress creation errors; an assertion failure must still surface.
      if(!(err && (err.code==='EPERM'||err.code==='EACCES'||err.code==='ENOTSUP'))) throw err;
    }
    fs.rmSync(root,{recursive:true,force:true});
  });

  test('leaves unrelated JDBC values unchanged',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'dvs-certs-'));
    assert.strictEqual(resolveHostCertificateReferences('verify-full',root),'verify-full');
    assert.strictEqual(resolveContainerCertificateReferences('https://database.example/metadata'),'https://database.example/metadata');
    fs.rmSync(root,{recursive:true,force:true});
  });

  test('project paths reserve dv-certs beneath the discovered project root',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'dvs-project-'));
    const studio=path.join(root,'data_vault_studio');
    fs.mkdirSync(studio,{recursive:true});
    fs.writeFileSync(path.join(root,'start.sh'),'#!/bin/sh\n');
    fs.writeFileSync(path.join(root,'docker-compose.yaml'),'services: {}\n');
    const paths=createProjectPaths({studioDir:studio,env:{DVS_PROJECT_ROOT:root},cwd:studio});
    assert.strictEqual(paths.DV_CERTS_PATH,path.join(root,'dv-certs'));
    fs.rmSync(root,{recursive:true,force:true});
  });
});

describe('JDBC local-file confinement',()=>{
  test('rejects unmanaged host-local file paths and file URIs',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'dvs-certs-'));
    fs.mkdirSync(path.join(root,'dv-certs'),{recursive:true});
    const bad=[
      '/etc/ssl/private/ca.pem',
      'C:\\certs\\ca.pem',
      '\\\\server\\share\\ca.pem',
      'file:/tmp/ca.pem',
      'file:///tmp/ca.pem',
      'jar:file:/tmp/certs.jar!/ca.pem',
      '../certs/ca.pem',
      '~/certs/ca.pem',
      'jdbc:postgresql://db:5432/source?sslrootcert=/etc/ssl/ca.pem&sslmode=verify-full',
      'jdbc:sqlserver://db:1433;encrypt=true;trustStore=C:\\certs\\client.jks',
    ];
    for(const value of bad){
      assert.throws(()=>resolveHostCertificateReferences(value,root),/must use the project dv-certs\/ directory/);
      assert.throws(()=>resolveContainerCertificateReferences(value),/must use the project dv-certs\/ directory/);
    }
    fs.rmSync(root,{recursive:true,force:true});
  });

  test('allows managed dv-certs references including file: URLs and leaves remote URLs alone',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'dvs-certs-'));
    fs.mkdirSync(path.join(root,'dv-certs'),{recursive:true});
    assert.strictEqual(
      resolveHostCertificateReferences('file:dv-certs/client.p12',root),
      `file:${path.join(root,'dv-certs','client.p12')}`
    );
    assert.strictEqual(
      resolveContainerCertificateReferences('file:dv-certs/client.p12'),
      `file:${HOP_CERTS_ROOT}/client.p12`
    );
    assert.strictEqual(resolveHostCertificateReferences('https://example.test/certs/ca.pem',root),'https://example.test/certs/ca.pem');
    fs.rmSync(root,{recursive:true,force:true});
  });

  test('does not block the base path of a legitimate file-backed JDBC database URL',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'dvs-certs-'));
    assert.strictEqual(resolveHostCertificateReferences('jdbc:sqlite:/srv/data/source.sqlite',root),'jdbc:sqlite:/srv/data/source.sqlite');
    assert.strictEqual(resolveContainerCertificateReferences('jdbc:h2:file:/srv/data/source'),'jdbc:h2:file:/srv/data/source');
    fs.rmSync(root,{recursive:true,force:true});
  });
});
