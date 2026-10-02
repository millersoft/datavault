function createSourceDatabase({ Client, mysql, isPackDialect, getDatabasePack, runJdbcBridge, outboundConnectionPolicy, connectionTestTimeoutMs = 6000, resolveConnection = body => ({...body}) }){
  function makeClient(body){
    const { host, port, database, user, password } = body || {};
    if (!host || !database || !user) throw new Error('host, database, and user are required.');
    return new Client({
      host,
      port:port ? Number(port) : 5432,
      database,
      user,
      password:password || undefined,
      connectionTimeoutMillis:connectionTestTimeoutMs,
      ssl:body.ssl === false ? false : { rejectUnauthorized:false },
      lookup:body.lookup,
    });
  }

  async function connectPgWithFallback(body, alreadyResolved = false){
    const connection = alreadyResolved ? body : resolveConnection(body);
    const destination=await outboundConnectionPolicy.validateNetworkDestination({host:connection.host,port:connection.port,defaultPort:5432});
    connection.host=destination.host; connection.port=destination.port; connection.lookup=destination.lookup;
    const client = makeClient(connection);
    try {
      await client.connect();
      return client;
    } catch (err){
      if (/does not support SSL/i.test(err.message) && connection.ssl !== false){
        try { await client.end(); } catch (_) {}
        const plainClient = makeClient({ ...connection, ssl:false });
        await plainClient.connect();
        return plainClient;
      }
      throw err;
    }
  }

  async function openSourceConnection(body){
    const connection = resolveConnection(body || {});
    const dialect = String(connection.dialect || 'postgresql').toLowerCase();
    if (isPackDialect(dialect)){
      const pack = getDatabasePack(dialect);
      if (pack.source.enabled === false) throw new Error(`Database Pack ${pack.label} is not enabled as a source.`);
      return {
        dialect,
        pack,
        testSql:String(pack.jdbc.testSql || 'SELECT 1'),
        query:async sql => {
          const data = await runJdbcBridge(pack, connection, 'query', String(sql));
          return { rows:data.rows || [], fields:(data.fields || []).map(name=>({ name })), rowCount:Number(data.rowCount || 0) };
        },
        end:async () => {},
      };
    }
    if (dialect === 'mysql'){
      const { host, port, database, user, password } = connection;
      if (!host || !database || !user) throw new Error('host, database, and user are required.');
      const destination=await outboundConnectionPolicy.validateNetworkDestination({host,port,defaultPort:3306});
      const conn = await mysql.createConnection({
        host:destination.addresses[0], port:destination.port, database, user,
        password:password || undefined, connectTimeout:connectionTestTimeoutMs,
      });
      return {
        dialect:'mysql',
        query:async (sql, params) => {
          const [rows, fields] = await conn.query(sql, params);
          return { rows, fields:(fields || []).map(field=>({ name:field.name })), rowCount:Array.isArray(rows) ? rows.length : 0 };
        },
        end:async () => conn.end(),
      };
    }
    if (dialect !== 'postgresql') throw new Error(`Unsupported source dialect "${dialect}".`);
    const client = await connectPgWithFallback(connection, true);
    return {
      dialect:'postgresql',
      query:async (sql, params) => {
        const result = await client.query(sql, params);
        return { rows:result.rows, fields:(result.fields || []).map(field=>({ name:field.name })), rowCount:result.rowCount };
      },
      end:async () => client.end(),
    };
  }

  return { makeClient, connectPgWithFallback, openSourceConnection };
}

module.exports = { createSourceDatabase };
