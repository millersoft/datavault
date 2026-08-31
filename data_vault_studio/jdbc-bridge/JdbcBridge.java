import java.io.File;
import java.net.URL;
import java.net.URLClassLoader;
import java.sql.*;
import java.util.*;
import java.util.Base64;
import java.util.Properties;

public final class JdbcBridge {
  private static String esc(String s){
    if(s==null) return "";
    StringBuilder b=new StringBuilder();
    for(int i=0;i<s.length();i++){
      char c=s.charAt(i);
      switch(c){
        case '\\': b.append("\\\\"); break;
        case '"': b.append("\\\""); break;
        case '\n': b.append("\\n"); break;
        case '\r': b.append("\\r"); break;
        case '\t': b.append("\\t"); break;
        default:
          if(c<32) b.append(String.format("\\u%04x", (int)c)); else b.append(c);
      }
    }
    return b.toString();
  }
  private static String q(String s){ return s==null ? "null" : "\""+esc(s)+"\""; }
  private static String jsonValue(Object v){
    if(v==null) return "null";
    if(v instanceof Boolean || v instanceof Byte || v instanceof Short || v instanceof Integer || v instanceof Long || v instanceof Float || v instanceof Double || v instanceof java.math.BigDecimal || v instanceof java.math.BigInteger) return String.valueOf(v);
    if(v instanceof byte[]) return q(Base64.getEncoder().encodeToString((byte[])v));
    return q(String.valueOf(v));
  }
  private static String jdbcTypeName(int code){
    try { return JDBCType.valueOf(code).getName(); } catch(Exception e){ return "TYPE_"+code; }
  }
  private static Connection connect(String jar, String driverClass, String url, String user, String password, java.util.Map<String,String> options) throws Exception {
    URLClassLoader loader=new URLClassLoader(new URL[]{new File(jar).toURI().toURL()}, JdbcBridge.class.getClassLoader());
    Class<?> clazz=Class.forName(driverClass, true, loader);
    Driver driver=(Driver)clazz.getDeclaredConstructor().newInstance();
    Properties props=new Properties();
    // Hop applies "Options" tab entries as JDBC connection Properties. Set them
    // first so explicit user/password below always take precedence.
    if(options!=null){
      for(java.util.Map.Entry<String,String> e:options.entrySet()){
        if(e.getKey()!=null && !e.getKey().isEmpty() && e.getValue()!=null) props.setProperty(e.getKey(), e.getValue());
      }
    }
    if(user!=null && !user.isEmpty()) props.setProperty("user", user);
    if(password!=null && !password.isEmpty()) props.setProperty("password", password);
    Connection conn=driver.connect(url, props);
    if(conn==null) throw new SQLException("JDBC driver did not accept URL: "+url);
    return conn;
  }
  private static void printError(Throwable t){
    System.out.println("{\"ok\":false,\"error\":"+q(t.getMessage()==null?t.toString():t.getMessage())+"}");
  }
  private static String rsString(ResultSet rs, String name){ try { return rs.getString(name); } catch(Exception e){ return null; } }
  private static Integer rsInt(ResultSet rs, String name){ try { int v=rs.getInt(name); return rs.wasNull()?null:v; } catch(Exception e){ return null; } }

  private static void analyze(Connection conn) throws Exception {
    DatabaseMetaData md=conn.getMetaData();
    StringBuilder b=new StringBuilder();
    b.append("{\"ok\":true");
    b.append(",\"productName\":").append(q(md.getDatabaseProductName()));
    b.append(",\"productVersion\":").append(q(md.getDatabaseProductVersion()));
    b.append(",\"driverName\":").append(q(md.getDriverName()));
    b.append(",\"driverVersion\":").append(q(md.getDriverVersion()));
    b.append(",\"identifierQuote\":").append(q(md.getIdentifierQuoteString()));
    b.append(",\"storesLowerCaseIdentifiers\":").append(md.storesLowerCaseIdentifiers());
    b.append(",\"storesUpperCaseIdentifiers\":").append(md.storesUpperCaseIdentifiers());
    b.append(",\"supportsSchemas\":").append(md.supportsSchemasInTableDefinitions());
    b.append(",\"supportsCatalogs\":").append(md.supportsCatalogsInTableDefinitions());
    b.append(",\"supportsTransactions\":").append(md.supportsTransactions());
    b.append(",\"catalogTerm\":").append(q(md.getCatalogTerm()));
    b.append(",\"schemaTerm\":").append(q(md.getSchemaTerm()));
    String currentCatalog=null,currentSchema=null;
    try{ currentCatalog=conn.getCatalog(); }catch(Exception ignored){}
    try{ currentSchema=conn.getSchema(); }catch(Exception ignored){}
    b.append(",\"currentCatalog\":").append(q(currentCatalog));
    b.append(",\"currentSchema\":").append(q(currentSchema));
    b.append(",\"catalogs\":[");
    boolean first=true;
    try(ResultSet rs=md.getCatalogs()){
      while(rs.next()){
        if(!first)b.append(','); first=false; b.append(q(rs.getString(1)));
      }
    } catch(Exception ignored){}
    b.append("],\"schemas\":["); first=true;
    try(ResultSet rs=md.getSchemas()){
      while(rs.next()){
        if(!first)b.append(','); first=false;
        b.append("{\"schema\":").append(q(rsString(rs,"TABLE_SCHEM"))).append(",\"catalog\":").append(q(rsString(rs,"TABLE_CATALOG"))).append('}');
      }
    } catch(Exception ignored){}
    b.append("],\"types\":["); first=true;
    try(ResultSet rs=md.getTypeInfo()){
      while(rs.next()){
        if(!first)b.append(','); first=false;
        int code=rs.getInt("DATA_TYPE");
        b.append("{\"nativeType\":").append(q(rsString(rs,"TYPE_NAME")))
         .append(",\"jdbcType\":").append(q(jdbcTypeName(code)))
         .append(",\"jdbcTypeCode\":").append(code)
         .append(",\"precision\":").append(rsInt(rs,"PRECISION") == null ? "null" : rsInt(rs,"PRECISION"))
         .append(",\"literalPrefix\":").append(q(rsString(rs,"LITERAL_PREFIX")))
         .append(",\"literalSuffix\":").append(q(rsString(rs,"LITERAL_SUFFIX"))).append('}');
      }
    } catch(Exception ignored){}
    b.append("]}");
    System.out.println(b.toString());
  }

  private static void introspect(Connection conn, String catalog, String schema) throws Exception {
    DatabaseMetaData md=conn.getMetaData();
    String effectiveCatalog=emptyToNull(catalog);
    String effectiveSchema=emptyToNull(schema);
    // JDBC null means "no restriction". For a connection URL that already
    // selected a database/catalog, scanning with null leaks system and sibling
    // catalogs (for example MariaDB performance_schema). Prefer the namespace
    // selected by the live connection when Studio did not explicitly supply one.
    if(effectiveCatalog==null){ try{ effectiveCatalog=emptyToNull(conn.getCatalog()); }catch(Exception ignored){} }
    if(effectiveSchema==null){ try{ effectiveSchema=emptyToNull(conn.getSchema()); }catch(Exception ignored){} }
    Map<String,String> objectTypes=new LinkedHashMap<>();
    try(ResultSet rs=md.getTables(effectiveCatalog, effectiveSchema, "%", new String[]{"TABLE","VIEW"})){
      while(rs.next()) objectTypes.put(rs.getString("TABLE_NAME"), rs.getString("TABLE_TYPE"));
    }
    Map<String,List<Map<String,Object>>> columns=new LinkedHashMap<>();
    try(ResultSet rs=md.getColumns(effectiveCatalog, effectiveSchema, "%", "%")){
      while(rs.next()){
        String table=rs.getString("TABLE_NAME");
        Map<String,Object> c=new LinkedHashMap<>();
        int code=rs.getInt("DATA_TYPE");
        c.put("name",rs.getString("COLUMN_NAME"));
        c.put("nativeType",rs.getString("TYPE_NAME"));
        c.put("jdbcType",jdbcTypeName(code));
        c.put("jdbcTypeCode",code);
        c.put("length",rsInt(rs,"COLUMN_SIZE"));
        c.put("precision",rsInt(rs,"COLUMN_SIZE"));
        c.put("scale",rsInt(rs,"DECIMAL_DIGITS"));
        c.put("nullable",rs.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls);
        c.put("ordinalPosition",rsInt(rs,"ORDINAL_POSITION"));
        c.put("pk",false);
        columns.computeIfAbsent(table,k->new ArrayList<>()).add(c);
        objectTypes.putIfAbsent(table,"TABLE");
      }
    }
    for(String table: new ArrayList<>(columns.keySet())){
      Set<String> pks=new HashSet<>();
      try(ResultSet rs=md.getPrimaryKeys(effectiveCatalog, effectiveSchema, table)){
        while(rs.next()) pks.add(rs.getString("COLUMN_NAME"));
      } catch(Exception ignored){}
      for(Map<String,Object> c:columns.get(table)) if(pks.contains(String.valueOf(c.get("name")))) c.put("pk",true);
    }
    List<Map<String,Object>> fks=new ArrayList<>();
    for(String table: new ArrayList<>(columns.keySet())){
      try(ResultSet rs=md.getImportedKeys(effectiveCatalog, effectiveSchema, table)){
        while(rs.next()){
          Map<String,Object> fk=new LinkedHashMap<>();
          fk.put("table",rs.getString("FKTABLE_NAME"));
          fk.put("column",rs.getString("FKCOLUMN_NAME"));
          fk.put("refTable",rs.getString("PKTABLE_NAME"));
          fk.put("refColumn",rs.getString("PKCOLUMN_NAME"));
          fk.put("constraintName",rsString(rs,"FK_NAME"));
          fk.put("ordinalPosition",rsInt(rs,"KEY_SEQ"));
          fk.put("provenance","declared");
          fks.add(fk);
        }
      } catch(Exception ignored){}
    }
    StringBuilder b=new StringBuilder("{\"ok\":true,\"catalog\":"+q(effectiveCatalog)+",\"schema\":"+q(effectiveSchema)+",\"tables\":[");
    boolean firstT=true;
    for(Map.Entry<String,List<Map<String,Object>>> e:columns.entrySet()){
      if(!firstT)b.append(','); firstT=false;
      b.append("{\"name\":").append(q(e.getKey())).append(",\"objectType\":").append(q(String.valueOf(objectTypes.getOrDefault(e.getKey(),"TABLE")).toUpperCase().contains("VIEW")?"view":"table")).append(",\"columns\":[");
      boolean firstC=true;
      for(Map<String,Object> c:e.getValue()){
        if(!firstC)b.append(','); firstC=false;
        b.append('{'); boolean firstP=true;
        for(Map.Entry<String,Object> p:c.entrySet()){
          if(!firstP)b.append(','); firstP=false;
          b.append(q(p.getKey())).append(':').append(jsonValue(p.getValue()));
        }
        b.append('}');
      }
      b.append("]}");
    }
    b.append("],\"foreignKeys\":["); boolean firstF=true;
    for(Map<String,Object> fk:fks){
      if(!firstF)b.append(','); firstF=false; b.append('{'); boolean firstP=true;
      for(Map.Entry<String,Object> p:fk.entrySet()){
        if(!firstP)b.append(','); firstP=false; b.append(q(p.getKey())).append(':').append(jsonValue(p.getValue()));
      }
      b.append('}');
    }
    b.append("]}");
    System.out.println(b.toString());
  }

  private static String emptyToNull(String s){ return s==null || s.isEmpty() ? null : s; }

  private static void query(Connection conn, String sql) throws Exception {
    try(Statement st=conn.createStatement()){
      st.setQueryTimeout(30);
      boolean has=st.execute(sql);
      if(!has){ System.out.println("{\"ok\":true,\"rows\":[],\"fields\":[],\"rowCount\":0}"); return; }
      try(ResultSet rs=st.getResultSet()){
        ResultSetMetaData md=rs.getMetaData(); int n=md.getColumnCount();
        StringBuilder b=new StringBuilder("{\"ok\":true,\"fields\":[");
        for(int i=1;i<=n;i++){ if(i>1)b.append(','); b.append(q(md.getColumnLabel(i))); }
        b.append("],\"rows\":["); boolean firstR=true; int count=0;
        while(rs.next()){
          if(!firstR)b.append(','); firstR=false; count++; b.append('{');
          for(int i=1;i<=n;i++){
            if(i>1)b.append(','); b.append(q(md.getColumnLabel(i))).append(':').append(jsonValue(rs.getObject(i)));
          }
          b.append('}');
        }
        b.append("],\"rowCount\":").append(count).append('}'); System.out.println(b.toString());
      }
    }
  }

  private static List<String> splitSqlStatements(String sql){
    List<String> out=new ArrayList<>(); StringBuilder cur=new StringBuilder(); boolean single=false,dbl=false;
    for(int i=0;i<sql.length();i++){
      char c=sql.charAt(i);
      if(c=='\'' && !dbl){ single=!single; cur.append(c); continue; }
      if(c=='"' && !single){ dbl=!dbl; cur.append(c); continue; }
      if(c==';' && !single && !dbl){ if(!cur.toString().trim().isEmpty()) out.add(cur.toString().trim()); cur.setLength(0); }
      else cur.append(c);
    }
    if(!cur.toString().trim().isEmpty()) out.add(cur.toString().trim()); return out;
  }
  private static void execute(Connection conn, String sql) throws Exception {
    boolean oldAuto=conn.getAutoCommit();
    try{
      conn.setAutoCommit(false); int count=0;
      try(Statement st=conn.createStatement()){
        st.setQueryTimeout(120);
        for(String part:splitSqlStatements(sql)){ st.execute(part); count++; }
      }
      conn.commit(); System.out.println("{\"ok\":true,\"statements\":"+count+"}");
    }catch(Exception e){ try{conn.rollback();}catch(Exception ignored){} throw e; }
    finally{ try{conn.setAutoCommit(oldAuto);}catch(Exception ignored){} }
  }

  // Minimal parser for a flat JSON object of string->string (JDBC options).
  // Values are always strings on the sending side, so this handles only that
  // shape rather than pulling in a JSON dependency.
  private static java.util.Map<String,String> parseFlatJsonObject(String json){
    java.util.Map<String,String> map=new java.util.LinkedHashMap<>();
    if(json==null) return map;
    String s=json.trim();
    if(s.length()<2 || s.charAt(0)!='{') return map;
    int i=1;
    while(i<s.length()){
      while(i<s.length() && (s.charAt(i)==',' || Character.isWhitespace(s.charAt(i)))) i++;
      if(i<s.length() && s.charAt(i)=='}') break;
      if(i>=s.length() || s.charAt(i)!='"') break;
      StringBuilder key=new StringBuilder(); i++;
      while(i<s.length() && s.charAt(i)!='"'){ if(s.charAt(i)=='\\'&&i+1<s.length()){ i++; key.append(unescape(s.charAt(i))); } else key.append(s.charAt(i)); i++; }
      i++; // closing quote
      while(i<s.length() && Character.isWhitespace(s.charAt(i))) i++;
      if(i>=s.length() || s.charAt(i)!=':') break; i++;
      while(i<s.length() && Character.isWhitespace(s.charAt(i))) i++;
      if(i>=s.length() || s.charAt(i)!='"') break;
      StringBuilder val=new StringBuilder(); i++;
      while(i<s.length() && s.charAt(i)!='"'){ if(s.charAt(i)=='\\'&&i+1<s.length()){ i++; val.append(unescape(s.charAt(i))); } else val.append(s.charAt(i)); i++; }
      i++; // closing quote
      map.put(key.toString(), val.toString());
    }
    return map;
  }
  private static char unescape(char c){ switch(c){ case 'n': return '\n'; case 'r': return '\r'; case 't': return '\t'; default: return c; } }

  public static void main(String[] args){
    if(args.length<7){ printError(new IllegalArgumentException("Usage: JdbcBridge <mode> <jar> <driverClass> <url> <user> <password> <payloadBase64> [optionsBase64]")); return; }
    String mode=args[0], jar=args[1], driver=args[2], url=args[3], user=args[4], password=args[5];
    String payload=new String(Base64.getDecoder().decode(args[6]), java.nio.charset.StandardCharsets.UTF_8);
    // Optional 8th arg: base64-encoded flat JSON object of JDBC options. Absent
    // for older callers, so parsing stays fully backward compatible.
    java.util.Map<String,String> options=new java.util.LinkedHashMap<>();
    if(args.length>7 && args[7]!=null && !args[7].isEmpty()){
      String optionsJson=new String(Base64.getDecoder().decode(args[7]), java.nio.charset.StandardCharsets.UTF_8);
      options=parseFlatJsonObject(optionsJson);
    }
    try(Connection conn=connect(jar,driver,url,user,password,options)){
      if("analyze".equals(mode)) analyze(conn);
      else if("introspect".equals(mode)){
        String[] parts=payload.split("\\n",-1); introspect(conn,parts.length>0?parts[0]:"",parts.length>1?parts[1]:"");
      } else if("query".equals(mode)) query(conn,payload);
      else if("execute".equals(mode)) execute(conn,payload);
      else throw new IllegalArgumentException("Unknown mode: "+mode);
    } catch(Throwable t){ printError(t); }
  }
}
