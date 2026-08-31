import java.io.File;
import java.io.PrintStream;
import java.lang.annotation.Annotation;
import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.JarURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.CodeSource;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.LinkedHashSet;
import java.util.jar.JarFile;

/**
 * Extract the relational database catalogue from the exact Apache Hop runtime
 * that Studio ships with.
 *
 * Design rule: Hop is the source of truth.  There is intentionally no hand
 * maintained list of database class names in this file.  We initialise Hop,
 * ask PluginRegistry for DatabasePluginType entries, instantiate each plugin,
 * and query the IDatabase implementation for the information Studio needs.
 *
 * In particular we record IDatabase.isExplorable().  Hop documents this as the
 * flag distinguishing relational databases that can be explored from special
 * non-relational database plugins.  Studio treats an explorable database type
 * as a Table Input capable source.  GENERIC is retained in the catalogue but
 * cannot become a pre-generated Pack because the JDBC driver is supplied by
 * the user at connection time.
 *
 * stdout contains JSON only. Hop startup logging and diagnostics go to stderr.
 */
public final class HopCatalogExtractor {
  private static final String S_HOST = "HOSTSENTINELX";
  private static final String S_PORT = "34521";
  private static final String S_DB = "DBSENTINELX";

  public static void main(String[] args) {
    PrintStream jsonOut = System.out;
    System.setOut(System.err);

    try {
      configureHopPaths();
      Object registry = initialiseHopAndGetRegistry();
      List<?> plugins = listDatabasePlugins(registry);
      if (plugins.isEmpty()) {
        throw new IllegalStateException(
            "Hop registered zero database plugins. Check HOP_HOME and the exported Hop installation.");
      }

      List<Object> ordered = new ArrayList<Object>();
      ordered.addAll((List<?>) plugins);
      Collections.sort(ordered, Comparator.comparing(HopCatalogExtractor::pluginSortKey));

      List<String> rows = new ArrayList<String>();
      int loaded = 0;
      int tableInputCapable = 0;
      int fixedDrivers = 0;
      int concretePackCandidates = 0;

      for (Object plugin : ordered) {
        String registryId = firstPluginId(plugin);
        String registryName = firstNonEmpty(
            stringValue(invokeNoArg(plugin, "getName")),
            stringValue(invokeNoArg(plugin, "getDescription")),
            registryId);

        try {
          Object database = loadPluginMainClass(registry, plugin);
          if (database == null) {
            System.err.println("SKIP (cannot instantiate): " + registryId + " / " + registryName);
            rows.add(errorLine(registryId, registryName, "PluginRegistry returned null"));
            continue;
          }

          // Give the freshly-instantiated dialect the same identity Hop gives it
          // when creating a real connection, then let the dialect populate its
          // own default options/attributes. This is important: defaults belong
          // to Hop, not to Studio.
          invokeStringSetter(database, "setPluginId", registryId);
          invokeStringSetter(database, "setPluginName", registryName);
          invokeNoArg(database, "addDefaultOptions");

          String pluginId = firstNonEmpty(stringValue(invokeNoArg(database, "getPluginId")), registryId);
          String pluginName = firstNonEmpty(
              stringValue(invokeNoArg(database, "getPluginName")), registryName, pluginId);
          String className = database.getClass().getName();
          String module = deriveModule(className, pluginId);
          String driverClass = stringValue(invokeNoArg(database, "getDriverClass")).trim();
          Integer defaultPort = parsePort(invokeNoArg(database, "getDefaultDatabasePort"));
          if (defaultPort != null) invokeStringSetter(database, "setPort", String.valueOf(defaultPort));
          List<String> removeItems = stringArrayOrList(invokeNoArg(database, "getRemoveItems"));
          Map<String, Object> connectionForm = extractConnectionForm(database, removeItems, defaultPort);
          @SuppressWarnings("unchecked")
          List<Map<String, Object>> urlFields = (List<Map<String, Object>>) connectionForm.get("fields");
          UrlResult url = recoverUrl(database, urlFields);
          String driverJar = locateDriverJar(driverClass, database, plugin);

          Boolean explorableFlag = booleanOrNull(database, "isExplorable");
          Boolean testableFlag = booleanOrNull(database, "isTestable");
          Boolean exploringDisabledFlag = booleanOrNull(database, "isExploringDisabled");
          boolean noConnection = isNoConnectionType(pluginId, pluginName);
          boolean explorable = explorableFlag == null ? !noConnection : explorableFlag.booleanValue();
          boolean tableInput = !noConnection && explorable;
          boolean fixedJdbcDriver = !driverClass.isEmpty();
          boolean packEligible = tableInput && fixedJdbcDriver;

          if (tableInput) tableInputCapable++;
          if (fixedJdbcDriver) fixedDrivers++;
          if (packEligible) concretePackCandidates++;

          Map<String, Object> row = new LinkedHashMap<String, Object>();
          row.put("module", module);
          row.put("pluginId", pluginId);
          row.put("pluginIds", stringArrayOrList(invokeNoArg(plugin, "getIds")));
          row.put("pluginName", pluginName);
          row.put("description", stringValue(invokeNoArg(plugin, "getDescription")));
          row.put("className", className);
          row.put("pluginLibraries", basenameList(invokeNoArg(plugin, "getLibraries")));

          row.put("driverClass", driverClass);
          row.put("driverJar", driverJar);
          row.put("driverDownload", extractDriverDownload(invokeNoArg(database, "getDriverDownload")));
          row.put("defaultPort", defaultPort);
          row.put("accessType", integerOrNull(invokeNoArg(database, "getAccessType")));
          row.put("accessTypes", intArrayOrList(invokeNoArg(database, "getAccessTypeList")));

          row.put("urlTemplate", url.template);
          row.put("urlRaw", url.raw);
          row.put("urlStatus", url.status);
          row.put("baseUrlTemplate", url.baseTemplate);
          row.put("baseUrlRaw", url.baseRaw);
          row.put("defaultOptions", stringMap(invokeNoArg(database, "getDefaultOptions")));
          row.put("defaultAttributes", hopConnectionAttributes(database));
          row.put("requiresDatabaseName", booleanOrNull(database, "isRequiresName"));
          row.put("removeItems", removeItems);
          row.put("connectionForm", connectionForm);

          Map<String, Object> namespace = new LinkedHashMap<String, Object>();
          namespace.put("supportsSchemas", booleanOrNull(database, "isSupportsSchemas"));
          namespace.put("supportsCatalogs", booleanOrNull(database, "isSupportsCatalogs"));
          namespace.put("preferredSchema", nullIfEmpty(stringValue(invokeNoArg(database, "getPreferredSchemaName"))));
          namespace.put("startQuote", nullIfEmpty(stringValue(invokeNoArg(database, "getStartQuote"))));
          namespace.put("endQuote", nullIfEmpty(stringValue(invokeNoArg(database, "getEndQuote"))));
          namespace.put("useSchemaNameForTableList", booleanOrNull(database, "useSchemaNameForTableList"));
          namespace.put("tableTypes", stringArrayOrList(invokeNoArg(database, "getTableTypes")));
          namespace.put("viewTypes", stringArrayOrList(invokeNoArg(database, "getViewTypes")));
          namespace.put("synonymTypes", stringArrayOrList(invokeNoArg(database, "getSynonymTypes")));
          row.put("namespace", namespace);

          Map<String, Object> capabilities = new LinkedHashMap<String, Object>();
          capabilities.put("tableInput", Boolean.valueOf(tableInput));
          capabilities.put("explorable", explorableFlag == null ? Boolean.valueOf(explorable) : explorableFlag);
          capabilities.put("testable", testableFlag);
          capabilities.put("exploringDisabled", exploringDisabledFlag);
          capabilities.put("supportsViews", booleanOrNull(database, "isSupportsViews"));
          capabilities.put("supportsSynonyms", booleanOrNull(database, "isSupportsSynonyms"));
          capabilities.put("supportsOptionsInURL", booleanOrNull(database, "isSupportsOptionsInURL"));
          capabilities.put("supportsBooleanDataType", booleanOrNull(database, "isSupportsBooleanDataType"));
          capabilities.put("supportsTimestampDataType", booleanOrNull(database, "isSupportsTimestampDataType"));
          capabilities.put("supportsTransactions", booleanOrNull(database, "isSupportsTransactions"));
          capabilities.put("supportsPreparedStatementMetadataRetrieval", booleanOrNull(database, "isSupportsPreparedStatementMetadataRetrieval"));
          capabilities.put("quoteReservedWords", booleanOrNull(database, "isQuoteReservedWords"));
          capabilities.put("quoteAllFields", booleanOrNull(database, "isQuoteAllFields"));
          capabilities.put("preserveReservedCase", booleanOrNull(database, "isPreserveReservedCase"));
          capabilities.put("forcingIdentifiersToLowerCase", booleanOrNull(database, "isForcingIdentifiersToLowerCase"));
          capabilities.put("forcingIdentifiersToUpperCase", booleanOrNull(database, "isForcingIdentifiersToUpperCase"));
          capabilities.put("defaultingToUppercase", booleanOrNull(database, "isDefaultingToUppercase"));
          capabilities.put("requiringTransactionsOnQueries", booleanOrNull(database, "isRequiringTransactionsOnQueries"));
          row.put("capabilities", capabilities);

          Map<String, Object> optionSyntax = new LinkedHashMap<String, Object>();
          optionSyntax.put("indicator", nullIfEmpty(stringValue(invokeNoArg(database, "getExtraOptionIndicator"))));
          optionSyntax.put("separator", nullIfEmpty(stringValue(invokeNoArg(database, "getExtraOptionSeparator"))));
          optionSyntax.put("valueSeparator", nullIfEmpty(stringValue(invokeNoArg(database, "getExtraOptionValueSeparator"))));
          row.put("optionSyntax", optionSyntax);

          row.put("databaseFactoryName", nullIfEmpty(stringValue(invokeNoArg(database, "getDatabaseFactoryName"))));
          row.put("fixedJdbcDriver", Boolean.valueOf(fixedJdbcDriver));
          row.put("packEligible", Boolean.valueOf(packEligible));

          rows.add(toJson(row));
          loaded++;
        } catch (Throwable t) {
          Throwable root = unwrap(t);
          System.err.println("ERROR loading database plugin " + registryId + " / " + registryName + ": " + root);
          rows.add(errorLine(registryId, registryName, root.toString()));
        }
      }

      System.err.println("Hop database plugins discovered: " + plugins.size());
      System.err.println("Database plugin implementations loaded: " + loaded);
      System.err.println("Table Input capable relational types: " + tableInputCapable);
      System.err.println("Types with a fixed JDBC driverClass: " + fixedDrivers);
      System.err.println("Concrete Table Input types with fixed JDBC driverClass: " + concretePackCandidates);

      jsonOut.println("[" + String.join(",\n", rows) + "]");
    } catch (Throwable t) {
      Throwable root = unwrap(t);
      System.err.println("ERROR: " + root);
      root.printStackTrace(System.err);
      System.exit(2);
    } finally {
      System.setOut(jsonOut);
    }
  }

  private static void configureHopPaths() {
    String hopHome = System.getenv("HOP_HOME");
    if (hopHome == null || hopHome.trim().isEmpty()) hopHome = "/opt/hop";
    hopHome = new File(hopHome).getAbsolutePath();

    if (System.getProperty("HOP_PLUGIN_BASE_FOLDERS") == null) {
      System.setProperty("HOP_PLUGIN_BASE_FOLDERS", new File(hopHome, "plugins").getAbsolutePath());
    }
    if (System.getProperty("HOP_SHARED_JDBC_FOLDERS") == null) {
      System.setProperty("HOP_SHARED_JDBC_FOLDERS", new File(hopHome, "lib/jdbc").getAbsolutePath());
    }

    System.err.println("Hop plugin folders: " + System.getProperty("HOP_PLUGIN_BASE_FOLDERS"));
    System.err.println("Hop shared JDBC folders: " + System.getProperty("HOP_SHARED_JDBC_FOLDERS"));
  }

  private static Object initialiseHopAndGetRegistry() throws Exception {
    Class<?> env = Class.forName("org.apache.hop.core.HopEnvironment");
    env.getMethod("init").invoke(null);
    Class<?> registryClass = Class.forName("org.apache.hop.core.plugins.PluginRegistry");
    return registryClass.getMethod("getInstance").invoke(null);
  }

  @SuppressWarnings("unchecked")
  private static List<?> listDatabasePlugins(Object registry) throws Exception {
    Class<?> databasePluginType = Class.forName("org.apache.hop.core.database.DatabasePluginType");
    Method getPlugins = registry.getClass().getMethod("getPlugins", Class.class);
    Object result = getPlugins.invoke(registry, databasePluginType);
    if (!(result instanceof List<?>)) {
      throw new IllegalStateException("PluginRegistry.getPlugins(DatabasePluginType.class) did not return a List");
    }
    return (List<?>) result;
  }

  private static Object loadPluginMainClass(Object registry, Object plugin) throws Exception {
    for (Method m : registry.getClass().getMethods()) {
      if (!m.getName().equals("loadClass") || m.getParameterCount() != 1) continue;
      Class<?> p = m.getParameterTypes()[0];
      if (!p.isAssignableFrom(plugin.getClass())) continue;
      return m.invoke(registry, plugin);
    }
    throw new NoSuchMethodException("No compatible PluginRegistry.loadClass(plugin) method found");
  }

  private static String pluginSortKey(Object plugin) {
    String name = stringValue(invokeNoArg(plugin, "getName"));
    if (name.isEmpty()) name = firstPluginId(plugin);
    return name.toLowerCase(Locale.ROOT);
  }

  private static String firstPluginId(Object plugin) {
    Object ids = invokeNoArg(plugin, "getIds");
    List<String> values = stringArrayOrList(ids);
    for (String id : values) {
      if (id != null && !id.trim().isEmpty()) return id.trim();
    }
    return "UNKNOWN";
  }

  private static String deriveModule(String className, String pluginId) {
    final String prefix = "org.apache.hop.databases.";
    if (className != null && className.startsWith(prefix)) {
      String rest = className.substring(prefix.length());
      int dot = rest.indexOf('.');
      if (dot > 0) return safeId(rest.substring(0, dot));
    }
    return safeId(pluginId);
  }

  private static String safeId(String value) {
    String s = value == null ? "" : value.toLowerCase(Locale.ROOT);
    s = s.replaceAll("[^a-z0-9._-]+", "-");
    s = s.replaceAll("^-+|-+$", "");
    return s.isEmpty() ? "unknown" : s;
  }

  private static boolean isNoConnectionType(String pluginId, String label) {
    String id = pluginId == null ? "" : pluginId.trim().toUpperCase(Locale.ROOT);
    String name = label == null ? "" : label.trim().toLowerCase(Locale.ROOT);
    return id.equals("NONE") || name.equals("no connection type");
  }

  // ---- JDBC URL recovery -------------------------------------------------

  private static final class UrlResult {
    String template;
    String raw;
    String status;
    String baseTemplate;
    String baseRaw;
  }

  private static UrlResult recoverUrl(Object database, List<Map<String, Object>> fields) {
    UrlResult r = new UrlResult();

    // First ask Hop for the URL using ONLY the canonical connection inputs our
    // Data Vault engine can supply: host, port and database.  This is the
    // profile-fit URL.  Database-specific widgets remain at their Hop defaults.
    // Keeping this separate from the fully-probed URL lets Studio distinguish
    // optional Hop GUI fields (for example SQL Server instance name) from
    // fields the engine actually needs to provide.
    r.baseRaw = callGetUrl(database, S_HOST, S_PORT, S_DB);
    r.baseTemplate = standardUrlTemplate(r.baseRaw);

    Map<Map<String, Object>, Object> originals = new LinkedHashMap<Map<String, Object>, Object>();
    Map<String, String> sentinels = new LinkedHashMap<String, String>();
    int index = 0;

    // Hop's getURL(host, port, database) covers the standard three fields.
    // Database-specific widgets can also participate in URL construction (for
    // example HTTP paths or vendor-specific endpoints). Give those text-like
    // fields unique values before calling getURL(), then translate whatever Hop
    // emits back into named placeholders. This lets Hop define our URL shape.
    for (Map<String, Object> field : fields == null ? Collections.<Map<String, Object>>emptyList() : fields) {
      if (!Boolean.TRUE.equals(field.get("visible"))) continue;
      String hopId = stringValue(field.get("hopFieldId"));
      String type = stringValue(field.get("hopType"));
      if (hopId.equals("hostname") || hopId.equals("port") || hopId.equals("databaseName")
          || hopId.equals("username") || hopId.equals("password") || hopId.equals("manualUrl")) continue;
      if (!(type.equals("TEXT") || type.equals("MULTI_LINE_TEXT") || type.equals("FILENAME") || type.equals("FOLDER"))) continue;
      String key = safeFieldKey(stringValue(field.get("key")));
      if (key.isEmpty()) continue;
      String sentinel = "DVSFIELD" + (index++) + "XYZ";
      Object original = getConnectionFieldValue(database, field);
      if (setConnectionFieldValue(database, field, sentinel)) {
        originals.put(field, original);
        sentinels.put(sentinel, key);
      }
    }

    String raw;
    try {
      raw = callGetUrl(database, S_HOST, S_PORT, S_DB);
    } finally {
      for (Map.Entry<Map<String, Object>, Object> entry : originals.entrySet()) {
        setConnectionFieldValue(database, entry.getKey(), entry.getValue());
      }
    }

    r.raw = raw;
    if (raw == null || raw.trim().isEmpty()) {
      r.status = "manual";
      return r;
    }

    String t = raw;
    int replacements = 0;
    if (t.contains(S_HOST)) { t = t.replace(S_HOST, "{host}"); replacements++; }
    if (t.contains(S_DB)) { t = t.replace(S_DB, "{database}"); replacements++; }
    if (t.contains(S_PORT)) { t = t.replace(S_PORT, "{port}"); replacements++; }
    for (Map.Entry<String, String> entry : sentinels.entrySet()) {
      if (t.contains(entry.getKey())) {
        t = t.replace(entry.getKey(), "{" + entry.getValue() + "}");
        replacements++;
      }
    }

    r.template = t;
    r.status = replacements > 0 ? "extracted" : "literal";
    return r;
  }


  private static String standardUrlTemplate(String raw) {
    if (raw == null || raw.trim().isEmpty()) return null;
    String t = raw;
    if (t.contains(S_HOST)) t = t.replace(S_HOST, "{host}");
    if (t.contains(S_DB)) t = t.replace(S_DB, "{database}");
    if (t.contains(S_PORT)) t = t.replace(S_PORT, "{port}");
    return t;
  }

  private static String callGetUrl(Object database, String host, String port, String db) {
    for (Method mm : database.getClass().getMethods()) {
      if (!mm.getName().equals("getURL")) continue;
      Class<?>[] p = mm.getParameterTypes();
      try {
        if (p.length == 3 && allStrings(p)) {
          Object out = mm.invoke(database, host, port, db);
          if (out != null) return out.toString();
        } else if (p.length == 4
            && p[1] == String.class && p[2] == String.class && p[3] == String.class) {
          Object out = mm.invoke(database, new Object[]{null, host, port, db});
          if (out != null) return out.toString();
        }
      } catch (Throwable ignored) {
        // Try another overload.
      }
    }
    return null;
  }

  // ---- Hop connection editor extraction ----------------------------------

  private static final String GUI_PARENT_ID = "DatabaseMeta-PluginSpecific-Options";
  private static final String GUI_WIDGET_ANNOTATION = "org.apache.hop.core.gui.plugin.GuiWidgetElement";

  private static Map<String, Object> extractConnectionForm(Object database, List<String> removeItems, Integer defaultPort) {
    Set<String> removed = new LinkedHashSet<String>();
    for (String item : removeItems == null ? Collections.<String>emptyList() : removeItems) {
      if (item != null) removed.add(item.trim());
    }

    Map<String, Map<String, Object>> byId = new LinkedHashMap<String, Map<String, Object>>();
    List<Class<?>> hierarchy = new ArrayList<Class<?>>();
    for (Class<?> c = database.getClass(); c != null && c != Object.class; c = c.getSuperclass()) hierarchy.add(c);
    Collections.reverse(hierarchy); // base widgets first; subclass annotations can override them.

    for (Class<?> c : hierarchy) {
      for (Field field : c.getDeclaredFields()) {
        Annotation annotation = findGuiWidgetAnnotation(field.getDeclaredAnnotations());
        if (annotation == null) continue;
        Map<String, Object> meta = widgetMetadata(database, field, null, annotation, removed);
        String id = stringValue(meta.get("hopFieldId"));
        if (!id.isEmpty()) byId.put(id, meta);
      }
      for (Method method : c.getDeclaredMethods()) {
        Annotation annotation = findGuiWidgetAnnotation(method.getDeclaredAnnotations());
        if (annotation == null) continue;
        Map<String, Object> meta = widgetMetadata(database, null, method, annotation, removed);
        String id = stringValue(meta.get("hopFieldId"));
        if (!id.isEmpty()) byId.put(id, meta);
      }
    }

    // DatabaseMetaEditor creates these three standard fields outside the
    // annotation-driven plugin composite. They are still part of Hop's General
    // connection tab and are governed by the same getRemoveItems() list.
    addEditorStandardField(byId, database, removed, "username", "Username", "TEXT", "90", false, null);
    addEditorStandardField(byId, database, removed, "password", "Password", "TEXT", "91", true, null);
    addEditorStandardField(byId, database, removed, "manualUrl", "Manual connection URL", "TEXT", "99", false, null);

    if (byId.containsKey("port") && defaultPort != null) {
      Map<String, Object> port = byId.get("port");
      Object value = port.get("default");
      if (value == null || stringValue(value).trim().isEmpty()) port.put("default", String.valueOf(defaultPort));
    }

    List<Map<String, Object>> fields = new ArrayList<Map<String, Object>>(byId.values());
    Collections.sort(fields, (a, b) -> {
      int x = stringValue(a.get("groupOrder")).compareTo(stringValue(b.get("groupOrder")));
      if (x != 0) return x;
      x = stringValue(a.get("group")).compareTo(stringValue(b.get("group")));
      if (x != 0) return x;
      x = stringValue(a.get("order")).compareTo(stringValue(b.get("order")));
      if (x != 0) return x;
      return stringValue(a.get("hopFieldId")).compareTo(stringValue(b.get("hopFieldId")));
    });

    Map<String, Object> form = new LinkedHashMap<String, Object>();
    form.put("source", "Hop DatabaseMetaEditor metadata");
    form.put("parentId", GUI_PARENT_ID);
    form.put("removedItems", new ArrayList<String>(removed));
    form.put("fields", fields);
    form.put("hasDynamicWidgetListener", implementsInterface(database.getClass(), "org.apache.hop.ui.core.gui.IGuiPluginCompositeWidgetsListener"));
    form.put("optionsTab", Boolean.TRUE);
    form.put("manualUrlField", !removed.contains("manualUrl"));
    form.put("advancedPreferredSchema", booleanOrNull(database, "isSupportsSchemas"));
    form.put("sshTunnelTab", hasMethod(database, "isSshTunnelEnabled") || hasMethod(database, "getSshTunnelHost"));
    return form;
  }

  private static Annotation findGuiWidgetAnnotation(Annotation[] annotations) {
    if (annotations == null) return null;
    for (Annotation annotation : annotations) {
      if (annotation != null && GUI_WIDGET_ANNOTATION.equals(annotation.annotationType().getName())) return annotation;
    }
    return null;
  }

  private static Map<String, Object> widgetMetadata(
      Object database, Field field, Method method, Annotation annotation, Set<String> removed) {
    Map<String, Object> out = new LinkedHashMap<String, Object>();
    String id = annotationString(annotation, "id");
    if (id.isEmpty()) id = field != null ? field.getName() : (method != null ? method.getName() : "");
    String parentId = annotationString(annotation, "parentId");
    String hopType = annotationEnum(annotation, "type");
    boolean ignored = annotationBoolean(annotation, "ignored", false);
    boolean visible = !ignored && (parentId.isEmpty() || GUI_PARENT_ID.equals(parentId)) && !removed.contains(id);
    String labelRaw = annotationString(annotation, "label");
    String tooltipRaw = annotationString(annotation, "toolTip");
    Class<?> owner = field != null ? field.getDeclaringClass() : method.getDeclaringClass();
    String fallbackPackage = owner.getPackage() == null ? "" : owner.getPackage().getName();
    String label = resolveI18n(labelRaw, fallbackPackage);
    String tooltip = resolveI18n(tooltipRaw, fallbackPackage);
    String property = field != null ? field.getName() : derivePropertyName(method == null ? "" : method.getName());
    String getter = annotationString(annotation, "getterMethod");
    String setter = annotationString(annotation, "setterMethod");
    if (getter.isEmpty()) getter = defaultGetterName(database, property, field);
    if (setter.isEmpty()) setter = defaultSetterName(property);

    out.put("hopFieldId", id);
    out.put("key", safeFieldKey(id));
    out.put("property", property);
    out.put("getter", getter);
    out.put("setter", setter);
    out.put("hopType", hopType);
    out.put("label", firstNonEmpty(label, humanize(id)));
    out.put("labelRaw", nullIfEmpty(labelRaw));
    out.put("toolTip", nullIfEmpty(tooltip));
    out.put("toolTipRaw", nullIfEmpty(tooltipRaw));
    out.put("order", annotationString(annotation, "order"));
    out.put("group", annotationString(annotation, "group"));
    out.put("groupOrder", annotationString(annotation, "groupOrder"));
    out.put("parentId", parentId);
    out.put("password", Boolean.valueOf(annotationBoolean(annotation, "password", false)));
    out.put("variables", Boolean.valueOf(annotationBoolean(annotation, "variables", true)));
    out.put("ignored", Boolean.valueOf(ignored));
    out.put("visible", Boolean.valueOf(visible));
    out.put("sourceClass", field != null ? field.getDeclaringClass().getName() : method.getDeclaringClass().getName());
    out.put("sourceMember", field != null ? field.getName() : method.getName());
    Object value = getConnectionFieldValue(database, out);
    out.put("default", simpleValue(value));

    String comboValuesMethod = annotationString(annotation, "comboValuesMethod");
    out.put("comboValuesMethod", nullIfEmpty(comboValuesMethod));
    if (!comboValuesMethod.isEmpty()) out.put("options", stringArrayOrList(invokeNoArg(database, comboValuesMethod)));
    return out;
  }

  private static void addEditorStandardField(
      Map<String, Map<String, Object>> byId, Object database, Set<String> removed,
      String id, String label, String type, String order, boolean password, Object defaultValue) {
    Map<String, Object> out = new LinkedHashMap<String, Object>();
    out.put("hopFieldId", id);
    out.put("key", safeFieldKey(id));
    out.put("property", id);
    out.put("getter", defaultGetterName(database, id, null));
    out.put("setter", defaultSetterName(id));
    out.put("hopType", type);
    out.put("label", label);
    out.put("order", order);
    out.put("group", "");
    out.put("groupOrder", "");
    out.put("parentId", "DatabaseMetaEditor-General");
    out.put("password", Boolean.valueOf(password));
    out.put("variables", Boolean.TRUE);
    out.put("ignored", Boolean.FALSE);
    out.put("visible", Boolean.valueOf(!removed.contains(id)));
    out.put("sourceClass", "org.apache.hop.ui.core.database.DatabaseMetaEditor");
    out.put("sourceMember", id);
    Object value = getConnectionFieldValue(database, out);
    out.put("default", value == null ? defaultValue : simpleValue(value));
    byId.put(id, out);
  }

  private static String resolveI18n(String raw, String fallbackPackage) {
    if (raw == null || raw.trim().isEmpty()) return "";
    if (!raw.startsWith("i18n:")) return raw;
    String body = raw.substring("i18n:".length());
    int sep = body.indexOf(':');
    if (sep < 0) return raw;
    String packageName = body.substring(0, sep);
    if (packageName.isEmpty()) packageName = fallbackPackage == null ? "" : fallbackPackage;
    String key = body.substring(sep + 1);
    try {
      Class<?> messages = Class.forName("org.apache.hop.i18n.BaseMessages");
      Method getString = messages.getMethod("getString", String.class, String.class);
      Object value = getString.invoke(null, packageName, key);
      String text = stringValue(value);
      if (!text.isEmpty() && !text.startsWith("!")) return text;
    } catch (Throwable ignored) {
      // Keep the raw i18n key for provenance and fall back to a humanized id.
    }
    return "";
  }

  private static String annotationString(Annotation annotation, String name) {
    Object value = annotationValue(annotation, name);
    return value == null ? "" : String.valueOf(value);
  }

  private static String annotationEnum(Annotation annotation, String name) {
    Object value = annotationValue(annotation, name);
    return value == null ? "" : String.valueOf(value);
  }

  private static boolean annotationBoolean(Annotation annotation, String name, boolean fallback) {
    Object value = annotationValue(annotation, name);
    return value instanceof Boolean ? ((Boolean) value).booleanValue() : fallback;
  }

  private static Object annotationValue(Annotation annotation, String name) {
    if (annotation == null) return null;
    try { return annotation.annotationType().getMethod(name).invoke(annotation); }
    catch (Throwable ignored) { return null; }
  }

  private static Object getConnectionFieldValue(Object database, Map<String, Object> meta) {
    String getter = stringValue(meta.get("getter"));
    if (!getter.isEmpty()) {
      Object value = invokeNoArg(database, getter);
      if (value != null) return value;
    }
    String property = stringValue(meta.get("property"));
    for (Class<?> c = database.getClass(); c != null && c != Object.class; c = c.getSuperclass()) {
      try {
        Field field = c.getDeclaredField(property);
        field.setAccessible(true);
        return field.get(database);
      } catch (Throwable ignored) { }
    }
    return null;
  }

  private static boolean setConnectionFieldValue(Object database, Map<String, Object> meta, Object value) {
    String setter = stringValue(meta.get("setter"));
    if (!setter.isEmpty()) {
      for (Method m : database.getClass().getMethods()) {
        if (!m.getName().equals(setter) || m.getParameterCount() != 1) continue;
        try {
          Object converted = convertValue(value, m.getParameterTypes()[0]);
          m.invoke(database, converted);
          return true;
        } catch (Throwable ignored) { }
      }
    }
    String property = stringValue(meta.get("property"));
    for (Class<?> c = database.getClass(); c != null && c != Object.class; c = c.getSuperclass()) {
      try {
        Field field = c.getDeclaredField(property);
        field.setAccessible(true);
        field.set(database, convertValue(value, field.getType()));
        return true;
      } catch (Throwable ignored) { }
    }
    return false;
  }

  private static Object convertValue(Object value, Class<?> type) {
    if (value == null) return null;
    if (type == String.class) return String.valueOf(value);
    if (type == boolean.class || type == Boolean.class) return Boolean.valueOf(String.valueOf(value));
    if (type == int.class || type == Integer.class) {
      try { return Integer.valueOf(String.valueOf(value)); } catch (Exception e) { return Integer.valueOf(0); }
    }
    return value;
  }

  private static Object simpleValue(Object value) {
    if (value == null || value instanceof String || value instanceof Number || value instanceof Boolean) return value;
    if (value.getClass().isEnum()) return String.valueOf(value);
    return String.valueOf(value);
  }

  private static String defaultGetterName(Object database, String property, Field field) {
    if (property == null || property.isEmpty()) return "";
    String suffix = Character.toUpperCase(property.charAt(0)) + property.substring(1);
    String isName = "is" + suffix;
    String getName = "get" + suffix;
    if (hasMethod(database, isName)) return isName;
    if (hasMethod(database, getName)) return getName;
    return getName;
  }

  private static String defaultSetterName(String property) {
    if (property == null || property.isEmpty()) return "";
    return "set" + Character.toUpperCase(property.charAt(0)) + property.substring(1);
  }

  private static String derivePropertyName(String method) {
    if (method == null) return "";
    String name = method;
    if (name.startsWith("get") && name.length() > 3) name = name.substring(3);
    else if (name.startsWith("is") && name.length() > 2) name = name.substring(2);
    else if (name.startsWith("set") && name.length() > 3) name = name.substring(3);
    if (name.isEmpty()) return "";
    return Character.toLowerCase(name.charAt(0)) + name.substring(1);
  }

  private static boolean hasMethod(Object target, String name) {
    return target != null && hasMethod(target.getClass(), name);
  }

  private static boolean hasMethod(Class<?> type, String name) {
    if (type == null || name == null || name.isEmpty()) return false;
    for (Method method : type.getMethods()) if (method.getName().equals(name)) return true;
    return false;
  }

  private static boolean implementsInterface(Class<?> type, String interfaceName) {
    for (Class<?> c = type; c != null && c != Object.class; c = c.getSuperclass()) {
      for (Class<?> i : c.getInterfaces()) {
        if (i.getName().equals(interfaceName) || implementsInterface(i, interfaceName)) return true;
      }
    }
    return false;
  }

  private static String safeFieldKey(String value) {
    if (value == null) return "";
    String s = value.trim().replaceAll("[^A-Za-z0-9_]", "_");
    if (s.isEmpty()) return s;
    if (!Character.isLetter(s.charAt(0)) && s.charAt(0) != '_') s = "field_" + s;
    return s;
  }

  private static String humanize(String value) {
    if (value == null || value.isEmpty()) return "";
    String s = value.replace('_', ' ').replace('-', ' ');
    s = s.replaceAll("([a-z0-9])([A-Z])", "$1 $2").trim();
    return s.isEmpty() ? value : Character.toUpperCase(s.charAt(0)) + s.substring(1);
  }

  // ---- JDBC driver discovery --------------------------------------------

  private static String locateDriverJar(String driverClass, Object database, Object plugin) {
    if (driverClass == null || driverClass.trim().isEmpty()) return null;
    String resource = driverClass.trim().replace('.', '/') + ".class";

    // Prefer the database plugin classloader. Driver jars in Hop plugins are
    // often not visible from the JDK sidecar's system classloader directly.
    ClassLoader[] loaders = new ClassLoader[]{
        database == null ? null : database.getClass().getClassLoader(),
        Thread.currentThread().getContextClassLoader(),
        HopCatalogExtractor.class.getClassLoader()
    };

    for (ClassLoader loader : loaders) {
      if (loader == null) continue;
      try {
        Class<?> driver = Class.forName(driverClass.trim(), false, loader);
        CodeSource source = driver.getProtectionDomain() == null ? null : driver.getProtectionDomain().getCodeSource();
        if (source != null && source.getLocation() != null) {
          String name = filenameFromLocation(source.getLocation());
          if (name != null && name.toLowerCase(Locale.ROOT).endsWith(".jar")) return name;
        }
      } catch (Throwable ignored) {
        // The driver may be intentionally absent (license-restricted).
      }

      try {
        URL u = loader.getResource(resource);
        String name = jarNameFromUrl(u);
        if (name != null) return name;
      } catch (Throwable ignored) {
        // Continue to plugin libraries.
      }
    }

    // Last resort: scan only the libraries declared by this plugin for the
    // driver class. This is deterministic and avoids scanning all 1000+ Hop jars.
    Object libraries = invokeNoArg(plugin, "getLibraries");
    for (String lib : stringArrayOrList(libraries)) {
      File file = new File(lib);
      if (!file.isFile() || !file.getName().toLowerCase(Locale.ROOT).endsWith(".jar")) continue;
      try (JarFile jar = new JarFile(file)) {
        if (jar.getJarEntry(resource) != null) return file.getName();
      } catch (Throwable ignored) {
        // Ignore unreadable library entries.
      }
    }
    return null;
  }

  private static String filenameFromLocation(URL url) {
    if (url == null) return null;
    try {
      String path = URLDecoder.decode(url.getPath(), StandardCharsets.UTF_8.name());
      if (path == null || path.isEmpty()) return null;
      return new File(path).getName();
    } catch (Throwable ignored) {
      return null;
    }
  }

  private static String jarNameFromUrl(URL url) {
    if (url == null) return null;
    try {
      if ("jar".equalsIgnoreCase(url.getProtocol())) {
        JarURLConnection conn = (JarURLConnection) url.openConnection();
        return filenameFromLocation(conn.getJarFileURL());
      }
      String raw = URLDecoder.decode(url.toString(), StandardCharsets.UTF_8.name());
      int bang = raw.indexOf("!/");
      if (bang > 0) {
        String before = raw.substring(0, bang);
        if (before.startsWith("jar:")) before = before.substring(4);
        if (before.startsWith("file:")) before = before.substring(5);
        return new File(before).getName();
      }
    } catch (Throwable ignored) {
      // Driver can still be valid even when its containing jar is unknown.
    }
    return null;
  }

  private static Map<String, Object> extractDriverDownload(Object descriptor) {
    if (descriptor == null) return null;
    Map<String, Object> out = new LinkedHashMap<String, Object>();
    out.put("mavenCoordinate", nullIfEmpty(stringValue(invokeNoArg(descriptor, "getMavenCoordinate"))));
    out.put("defaultVersion", nullIfEmpty(stringValue(invokeNoArg(descriptor, "getDefaultVersion"))));
    out.put("licenseCategory", nullIfEmpty(stringValue(invokeNoArg(descriptor, "getLicenseCategory"))));
    out.put("licenseName", nullIfEmpty(stringValue(invokeNoArg(descriptor, "getLicenseName"))));
    out.put("licenseUrl", nullIfEmpty(stringValue(invokeNoArg(descriptor, "getLicenseUrl"))));
    out.put("vendor", nullIfEmpty(stringValue(invokeNoArg(descriptor, "getVendor"))));
    out.put("vendorUrl", nullIfEmpty(stringValue(invokeNoArg(descriptor, "getVendorUrl"))));
    out.put("notes", nullIfEmpty(stringValue(invokeNoArg(descriptor, "getNotes"))));
    out.put("repositoryUrl", nullIfEmpty(stringValue(invokeNoArg(descriptor, "getRepositoryUrl"))));
    out.put("restricted", booleanOrNull(descriptor, "isRestricted"));
    out.put("excludes", stringArrayOrList(invokeNoArg(descriptor, "getExcludes")));
    out.put("companionCoordinates", stringArrayOrList(invokeNoArg(descriptor, "getCompanionCoordinates")));
    return out;
  }

  // ---- reflection helpers ------------------------------------------------

  private static Object invokeNoArg(Object target, String name) {
    if (target == null) return null;
    try {
      Method mm = target.getClass().getMethod(name);
      return mm.invoke(target);
    } catch (Throwable ignored) {
      return null;
    }
  }


  private static void invokeStringSetter(Object target, String name, String value) {
    if (target == null) return;
    try {
      Method mm = target.getClass().getMethod(name, String.class);
      mm.invoke(target, value);
    } catch (Throwable ignored) {
      // Older/third-party database plugins can omit optional setters.
    }
  }

  private static void putBooleanAttribute(Map<String, String> out, Object target, String method, String key) {
    Boolean value = booleanOrNull(target, method);
    if (value != null) out.put(key, value.booleanValue() ? "Y" : "N");
  }

  private static Map<String, String> hopConnectionAttributes(Object database) {
    Map<String, String> out = stringMap(invokeNoArg(database, "getAttributes"));

    // These are the generic advanced connection properties serialized by Hop
    // for relational database metadata. Values are read from the dialect
    // instance after addDefaultOptions(), never maintained per database here.
    putBooleanAttribute(out, database, "isSupportsTimestampDataType", "SUPPORTS_TIMESTAMP_DATA_TYPE");
    putBooleanAttribute(out, database, "isQuoteAllFields", "QUOTE_ALL_FIELDS");
    putBooleanAttribute(out, database, "isSupportsBooleanDataType", "SUPPORTS_BOOLEAN_DATA_TYPE");
    putBooleanAttribute(out, database, "isForcingIdentifiersToLowerCase", "FORCE_IDENTIFIERS_TO_LOWERCASE");
    putBooleanAttribute(out, database, "isPreserveReservedCase", "PRESERVE_RESERVED_WORD_CASE");
    putBooleanAttribute(out, database, "isForcingIdentifiersToUpperCase", "FORCE_IDENTIFIERS_TO_UPPERCASE");

    String connectSql = stringValue(invokeNoArg(database, "getConnectSql"));
    out.put("SQL_CONNECT", connectSql);
    String preferredSchema = stringValue(invokeNoArg(database, "getPreferredSchemaName"));
    out.put("PREFERRED_SCHEMA_NAME", preferredSchema);
    return out;
  }

  private static Boolean booleanOrNull(Object target, String name) {
    Object v = invokeNoArg(target, name);
    if (v instanceof Boolean) return (Boolean) v;
    if (v == null) return null;
    String s = v.toString().trim();
    if (s.equalsIgnoreCase("true") || s.equalsIgnoreCase("y")) return Boolean.TRUE;
    if (s.equalsIgnoreCase("false") || s.equalsIgnoreCase("n")) return Boolean.FALSE;
    return null;
  }

  private static Integer integerOrNull(Object v) {
    if (v == null) return null;
    try { return Integer.valueOf(v.toString().trim()); } catch (Exception e) { return null; }
  }

  private static Integer parsePort(Object v) {
    Integer n = integerOrNull(v);
    return n == null || n.intValue() <= 0 ? null : n;
  }

  private static boolean allStrings(Class<?>[] p) {
    for (Class<?> c : p) if (c != String.class) return false;
    return true;
  }

  private static String stringValue(Object v) {
    return v == null ? "" : v.toString();
  }

  private static String nullIfEmpty(String v) {
    return v == null || v.trim().isEmpty() ? null : v;
  }

  private static String firstNonEmpty(String... values) {
    for (String s : values) if (s != null && !s.trim().isEmpty()) return s.trim();
    return "";
  }

  private static Throwable unwrap(Throwable t) {
    Throwable current = t;
    while (current instanceof InvocationTargetException
        && ((InvocationTargetException) current).getTargetException() != null) {
      current = ((InvocationTargetException) current).getTargetException();
    }
    return current;
  }

  private static List<String> basenameList(Object value) {
    List<String> result = new ArrayList<String>();
    for (String s : stringArrayOrList(value)) {
      if (s == null || s.isEmpty()) continue;
      result.add(new File(s).getName());
    }
    return result;
  }

  private static List<String> stringArrayOrList(Object value) {
    List<String> out = new ArrayList<String>();
    if (value == null) return out;
    if (value instanceof Collection<?>) {
      for (Object item : (Collection<?>) value) out.add(stringValue(item));
      return out;
    }
    Class<?> type = value.getClass();
    if (type.isArray()) {
      int length = Array.getLength(value);
      for (int i = 0; i < length; i++) out.add(stringValue(Array.get(value, i)));
      return out;
    }
    out.add(stringValue(value));
    return out;
  }

  private static List<Integer> intArrayOrList(Object value) {
    List<Integer> out = new ArrayList<Integer>();
    if (value == null) return out;
    if (value instanceof Collection<?>) {
      for (Object item : (Collection<?>) value) {
        Integer n = integerOrNull(item);
        if (n != null) out.add(n);
      }
      return out;
    }
    Class<?> type = value.getClass();
    if (type.isArray()) {
      int length = Array.getLength(value);
      for (int i = 0; i < length; i++) {
        Integer n = integerOrNull(Array.get(value, i));
        if (n != null) out.add(n);
      }
      return out;
    }
    Integer n = integerOrNull(value);
    if (n != null) out.add(n);
    return out;
  }

  private static Map<String, String> stringMap(Object value) {
    Map<String, String> out = new LinkedHashMap<String, String>();
    if (!(value instanceof Map<?, ?>)) return out;
    for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
      String key = stringValue(entry.getKey());
      if (!key.isEmpty()) out.put(key, stringValue(entry.getValue()));
    }
    return out;
  }

  // ---- JSON helpers ------------------------------------------------------

  private static String errorLine(String pluginId, String label, String error) {
    Map<String, Object> row = new LinkedHashMap<String, Object>();
    row.put("pluginId", pluginId);
    row.put("pluginName", label);
    row.put("error", error);
    row.put("packEligible", Boolean.FALSE);
    return toJson(row);
  }

  private static String toJson(Object value) {
    if (value == null) return "null";
    if (value instanceof String) return q((String) value);
    if (value instanceof Number || value instanceof Boolean) return value.toString();
    if (value instanceof Map<?, ?>) {
      List<String> parts = new ArrayList<String>();
      for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
        parts.add(q(stringValue(entry.getKey())) + ":" + toJson(entry.getValue()));
      }
      return "{" + String.join(",", parts) + "}";
    }
    if (value instanceof Collection<?>) {
      List<String> parts = new ArrayList<String>();
      for (Object item : (Collection<?>) value) parts.add(toJson(item));
      return "[" + String.join(",", parts) + "]";
    }
    if (value.getClass().isArray()) {
      List<String> parts = new ArrayList<String>();
      int length = Array.getLength(value);
      for (int i = 0; i < length; i++) parts.add(toJson(Array.get(value, i)));
      return "[" + String.join(",", parts) + "]";
    }
    return q(value.toString());
  }

  private static String q(String s) {
    if (s == null) return "null";
    StringBuilder b = new StringBuilder("\"");
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '\\': b.append("\\\\"); break;
        case '"': b.append("\\\""); break;
        case '\n': b.append("\\n"); break;
        case '\r': b.append("\\r"); break;
        case '\t': b.append("\\t"); break;
        default:
          if (c < 32) b.append(String.format("\\u%04x", (int) c));
          else b.append(c);
      }
    }
    return b.append("\"").toString();
  }
}
