'use strict';

const {test,describe}=require('node:test');
const assert=require('node:assert');
const {
  validatePort,normalizeHost,addressKind,createOutboundConnectionPolicy,effectiveJdbcDestination,structuredJdbcDestination,
}=require('../server/outbound-connections');

describe('outbound database connection policy',()=>{
  test('accepts only canonical ports in range',()=>{
    assert.strictEqual(validatePort('5432'),5432);
    assert.strictEqual(validatePort('',3306),3306);
    for(const value of ['0','-1','1.5','1e3',' 5432 ','65536','abc']){
      assert.throws(()=>validatePort(value),/integer from 1 to 65535/);
    }
  });

  test('rejects malformed hosts while accepting DNS and IP forms',()=>{
    assert.strictEqual(normalizeHost('db.internal'),'db.internal');
    assert.strictEqual(normalizeHost('[::1]'),'::1');
    for(const value of ['', ' db.internal', 'https://db.internal', 'user@host', 'host/path', 'bad_label']){
      assert.throws(()=>normalizeHost(value),/required|malformed/);
    }
  });

  test('classifies loopback, private, link-local, and public addresses',()=>{
    assert.strictEqual(addressKind('127.0.0.1'),'loopback');
    assert.strictEqual(addressKind('10.2.3.4'),'private');
    assert.strictEqual(addressKind('172.31.2.3'),'private');
    assert.strictEqual(addressKind('192.168.1.2'),'private');
    assert.strictEqual(addressKind('169.254.169.254'),'link-local');
    assert.strictEqual(addressKind('::1'),'loopback');
    assert.strictEqual(addressKind('0:0:0:0:0:0:0:1'),'loopback');
    assert.strictEqual(addressKind('fe80::1'),'link-local');
    assert.strictEqual(addressKind('fe80:0:0:0:0:0:0:1'),'link-local');
    assert.strictEqual(addressKind('fd00:ec2::254'),'metadata');
    assert.strictEqual(addressKind('100.100.100.200'),'metadata');
    assert.strictEqual(addressKind('168.63.129.16'),'metadata');
    assert.strictEqual(addressKind('::ffff:a9fe:a9fe'),'link-local');
    assert.strictEqual(addressKind('8.8.8.8'),'public');
  });

  test('blocks direct and DNS-resolved link-local destinations but allows private databases',async()=>{
    const records={
      'metadata.example':[{address:'169.254.169.254',family:4}],
      'private-db.example':[{address:'10.20.30.40',family:4}],
    };
    const policy=createOutboundConnectionPolicy({lookup:async host=>records[host]||[]});
    await assert.rejects(()=>policy.validateNetworkDestination({host:'metadata.example',port:'5432'}),/not allowed/);
    const allowed=await policy.validateNetworkDestination({host:'private-db.example',port:'5432'});
    assert.deepStrictEqual(allowed.kinds,['private']);
    await assert.rejects(()=>policy.inspectHost('169.254.169.254'),/not allowed/);
  });

  test('extracts the effective rendered JDBC destination and keeps file-backed packs local',()=>{
    const pack={jdbc:{urlTemplate:'jdbc:postgresql://{host}:{port}/{database}'},connectionFields:[
      {key:'host',mapsTo:'host'},{key:'port',mapsTo:'port'},
    ]};
    assert.deepStrictEqual(effectiveJdbcDestination(pack,{manualUrl:'jdbc:postgresql://169.254.169.254:5432/db'},'jdbc:postgresql://169.254.169.254:5432/db'),{host:'169.254.169.254',port:'5432'});
    assert.deepStrictEqual(effectiveJdbcDestination(pack,{manualUrl:'jdbc:postgresql://[::1]:5432/db'},'jdbc:postgresql://[::1]:5432/db'),{host:'::1',port:'5432'});
    assert.throws(()=>effectiveJdbcDestination(pack,{manualUrl:'jdbc:other:opaque-value'},'jdbc:other:opaque-value'),/could not be validated/);
    assert.deepStrictEqual(effectiveJdbcDestination(pack,{},'jdbc:postgresql://169.254.169.254:5432/db'),{host:'169.254.169.254',port:'5432'});
    assert.strictEqual(effectiveJdbcDestination({jdbc:{urlTemplate:'jdbc:sqlite:{database}'},connectionFields:[{key:'host',mapsTo:'host'}]},{},'jdbc:sqlite:local.db'),null);
    assert.deepStrictEqual(structuredJdbcDestination(pack,{host:'db.example;ssl=false',port:'5432'}),{host:'db.example;ssl=false',port:'5432'});
  });
});
