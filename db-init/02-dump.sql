--
-- PostgreSQL database dump
--

-- Dumped from database version 9.6.2
-- Dumped by pg_dump version 9.6.2

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET client_min_messages = warning;
SET row_security = off;

--
-- Bootstrap: database, roles, schemas, and role search paths
--
-- Usage:
--   psql -d postgres -v target_database=datavault -v shared_password='replace-with-a-secure-password' -f pdi_meta_data_vault_bootstrap.sql
--
-- Notes:
--   * Run this from a maintenance database such as postgres, not from inside a transaction.
--   * The executing account needs permission to create/alter roles and create/alter the target database.
--   * target_database defaults to datavault when it is not supplied.
--   * The password is supplied through the psql variable shared_password and is not stored in this file.
--

\if :{?target_database}
\else
\set target_database datavault
\endif

-- SET app.shared_password = :'shared_password';
SET app.shared_password = 'VAULT_PASSWORD';

DO $$
DECLARE
    shared_password text := current_setting('app.shared_password');
    role_name text;
BEGIN
    FOREACH role_name IN ARRAY ARRAY['pdi_meta', 'staging', 'data_vault']
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
            EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', role_name, shared_password);
        ELSE
            EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', role_name, shared_password);
        END IF;
    END LOOP;
END
$$;

SELECT format('CREATE DATABASE %I OWNER data_vault', :'target_database')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_database')\gexec

SELECT format('ALTER DATABASE %I OWNER TO data_vault', :'target_database')\gexec

\connect :target_database

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS pdi_meta AUTHORIZATION pdi_meta;
CREATE SCHEMA IF NOT EXISTS staging AUTHORIZATION staging;
CREATE SCHEMA IF NOT EXISTS data_vault AUTHORIZATION data_vault;

ALTER SCHEMA pdi_meta OWNER TO pdi_meta;
ALTER SCHEMA staging OWNER TO staging;
ALTER SCHEMA data_vault OWNER TO data_vault;

SELECT format('ALTER DATABASE %I SET search_path TO staging, data_vault, pdi_meta, public', :'target_database')\gexec

SELECT format('ALTER ROLE pdi_meta IN DATABASE %I SET search_path = pdi_meta, pg_catalog, public', :'target_database')\gexec
SELECT format('ALTER ROLE staging IN DATABASE %I SET search_path = staging, pg_catalog, public', :'target_database')\gexec
SELECT format('ALTER ROLE data_vault IN DATABASE %I SET search_path = data_vault, pg_catalog, public', :'target_database')\gexec

-- Grant full access on every target schema to all runtime roles.
GRANT ALL ON SCHEMA pdi_meta   TO pdi_meta, staging, data_vault;
GRANT ALL ON SCHEMA staging    TO pdi_meta, staging, data_vault;
GRANT ALL ON SCHEMA data_vault TO pdi_meta, staging, data_vault;

-- Set default privileges for objects created by the bootstrap user in each schema.
-- Note: ROUTINES covers both functions and procedures (PostgreSQL 11+)
ALTER DEFAULT PRIVILEGES IN SCHEMA pdi_meta   GRANT ALL ON TABLES    TO pdi_meta, staging, data_vault;
ALTER DEFAULT PRIVILEGES IN SCHEMA pdi_meta   GRANT ALL ON SEQUENCES TO pdi_meta, staging, data_vault;
ALTER DEFAULT PRIVILEGES IN SCHEMA pdi_meta   GRANT ALL ON ROUTINES  TO pdi_meta, staging, data_vault;
ALTER DEFAULT PRIVILEGES IN SCHEMA pdi_meta   GRANT ALL ON TYPES     TO pdi_meta, staging, data_vault;

ALTER DEFAULT PRIVILEGES IN SCHEMA staging    GRANT ALL ON TABLES    TO pdi_meta, staging, data_vault;
ALTER DEFAULT PRIVILEGES IN SCHEMA staging    GRANT ALL ON SEQUENCES TO pdi_meta, staging, data_vault;
ALTER DEFAULT PRIVILEGES IN SCHEMA staging    GRANT ALL ON ROUTINES  TO pdi_meta, staging, data_vault;
ALTER DEFAULT PRIVILEGES IN SCHEMA staging    GRANT ALL ON TYPES     TO pdi_meta, staging, data_vault;

ALTER DEFAULT PRIVILEGES IN SCHEMA data_vault GRANT ALL ON TABLES    TO pdi_meta, staging, data_vault;
ALTER DEFAULT PRIVILEGES IN SCHEMA data_vault GRANT ALL ON SEQUENCES TO pdi_meta, staging, data_vault;
ALTER DEFAULT PRIVILEGES IN SCHEMA data_vault GRANT ALL ON ROUTINES  TO pdi_meta, staging, data_vault;
ALTER DEFAULT PRIVILEGES IN SCHEMA data_vault GRANT ALL ON TYPES     TO pdi_meta, staging, data_vault;

-- Set default privileges for objects created by each schema-owning role itself.
-- This is the key fix: without FOR ROLE, triggers, tables, and functions created
-- by e.g. the staging role are NOT covered by the defaults above, causing
-- permission denied errors when pdi_meta procedures/triggers access them.
ALTER DEFAULT PRIVILEGES FOR ROLE pdi_meta   IN SCHEMA pdi_meta   GRANT ALL ON TABLES    TO pdi_meta, staging, data_vault;
ALTER DEFAULT PRIVILEGES FOR ROLE pdi_meta   IN SCHEMA pdi_meta   GRANT ALL ON SEQUENCES TO pdi_meta, staging, data_vault;
ALTER DEFAULT PRIVILEGES FOR ROLE pdi_meta   IN SCHEMA pdi_meta   GRANT ALL ON ROUTINES  TO pdi_meta, staging, data_vault;
ALTER DEFAULT PRIVILEGES FOR ROLE pdi_meta   IN SCHEMA pdi_meta   GRANT ALL ON TYPES     TO pdi_meta, staging, data_vault;

ALTER DEFAULT PRIVILEGES FOR ROLE staging    IN SCHEMA staging    GRANT ALL ON TABLES    TO pdi_meta, staging, data_vault;
ALTER DEFAULT PRIVILEGES FOR ROLE staging    IN SCHEMA staging    GRANT ALL ON SEQUENCES TO pdi_meta, staging, data_vault;
ALTER DEFAULT PRIVILEGES FOR ROLE staging    IN SCHEMA staging    GRANT ALL ON ROUTINES  TO pdi_meta, staging, data_vault;
ALTER DEFAULT PRIVILEGES FOR ROLE staging    IN SCHEMA staging    GRANT ALL ON TYPES     TO pdi_meta, staging, data_vault;

ALTER DEFAULT PRIVILEGES FOR ROLE data_vault IN SCHEMA data_vault GRANT ALL ON TABLES    TO pdi_meta, staging, data_vault;
ALTER DEFAULT PRIVILEGES FOR ROLE data_vault IN SCHEMA data_vault GRANT ALL ON SEQUENCES TO pdi_meta, staging, data_vault;
ALTER DEFAULT PRIVILEGES FOR ROLE data_vault IN SCHEMA data_vault GRANT ALL ON ROUTINES  TO pdi_meta, staging, data_vault;
ALTER DEFAULT PRIVILEGES FOR ROLE data_vault IN SCHEMA data_vault GRANT ALL ON TYPES     TO pdi_meta, staging, data_vault;

SET search_path = pdi_meta, pg_catalog;

--
-- Name: gen_lnk_qry_no_as(text); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION gen_lnk_qry_no_as(f1 text, OUT text) RETURNS text
    LANGUAGE sql
    AS $$
select case when f1 is not null then concat(',',concat(f1)) else '' end
$$;


ALTER FUNCTION pdi_meta.gen_lnk_qry_no_as(f1 text, OUT text) OWNER TO pdi_meta;

--
-- Name: gen_lnk_qry_w_as(text, text); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION gen_lnk_qry_w_as(f1 text, f2 text, OUT text) RETURNS text
    LANGUAGE sql
    AS $$
select case when f1 is not null then concat(',',concat(f1,' as ',f2)) else '' end
$$;


ALTER FUNCTION pdi_meta.gen_lnk_qry_w_as(f1 text, f2 text, OUT text) OWNER TO pdi_meta;

--
-- Name: ms_dv_cl_wrp_typ1(text); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION ms_dv_cl_wrp_typ1(f1 text, OUT text) RETURNS text
    LANGUAGE sql
    AS $_$
 select case when $1  is not null then concat('||''${CDC_DEL}''||coalesce(cast(',$1 ,' as text),''','${CDC_NULL}',''')') else '' end
 
$_$;


ALTER FUNCTION pdi_meta.ms_dv_cl_wrp_typ1(f1 text, OUT text) OWNER TO pdi_meta;

--
-- Name: ms_dv_cl_wrp_typ2(text, text); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION ms_dv_cl_wrp_typ2(f1 text, f2 text, OUT text) RETURNS text
    LANGUAGE sql
    AS $$
 select case when f1 is not null then concat(',',concat(f1,' as ',f2)) else '' end

$$;


ALTER FUNCTION pdi_meta.ms_dv_cl_wrp_typ2(f1 text, f2 text, OUT text) OWNER TO pdi_meta;

--
-- Name: prc_create_error_table(character varying, character varying); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION prc_create_error_table(p_table_name character varying, p_schema_name character varying) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE recordvar        RECORD;
DECLARE stmt_def         TEXT;
BEGIN

stmt_def := concat('create table if not exists ',p_schema_name,'.',p_table_name,'_err (');

FOR recordvar IN select concat(case when ordinal_position = 1 then '' else ',' end , column_name , ' '
,      case
          when column_name = 'load_dts'         then ' TIMESTAMP'
          when column_name = 'last_seen_dts'    then ' TIMESTAMP '
          when column_name = 'record_source_id' then ' INT'
          when ordinal_position  = 1            then ' TEXT DEFAULT -1'
          else                                       ' TEXT'
       end)
       as attribute
from   information_schema.columns
where  table_name   = p_table_name
and    table_schema = p_schema_name
order  by ordinal_position
LOOP
       stmt_def := concat(stmt_def,recordvar.attribute);
END LOOP;

stmt_def := concat(stmt_def,',etl_err_date timestamp default now(),etl_id_run int,etl_err_noe int, etl_err_desc varchar(512),etl_err_col varchar(256),etl_err_cod varchar(256) )');

EXECUTE stmt_def;

END;
$$;


ALTER FUNCTION pdi_meta.prc_create_error_table(p_table_name character varying, p_schema_name character varying) OWNER TO pdi_meta;

--
-- Name: prc_create_history_triggers(character varying); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION prc_create_history_triggers(p_table_name character varying) RETURNS text
    LANGUAGE plpgsql
    AS $_$
DECLARE stmt_def                      TEXT;
DECLARE table_columns                 TEXT;
DECLARE table_columns_old             TEXT;
DECLARE table_columns_new             TEXT;
BEGIN

select string_agg(column_name, ',' order by ordinal_position)
into   table_columns
from   information_schema.columns
where  table_name = p_table_name
and    table_schema = 'pdi_meta';

select string_agg(concat('OLD.',column_name),',' order by ordinal_position)
into   table_columns_old
from   information_schema.columns
where  table_name = p_table_name
and    table_schema = 'pdi_meta';

select string_agg(concat('NEW.',column_name),',' order by ordinal_position)
into   table_columns_new
from   information_schema.columns
where  table_name = p_table_name
and    table_schema = 'pdi_meta';

stmt_def =                  concat('create table pdi_meta.',p_table_name,'_hist as select * from ',p_table_name,' where 1 = 1;',CHR(13),CHR(10));

stmt_def =                  concat('alter table pdi_meta ',p_table_name,'_hist add (hist_date_insert DATETIME, dml_operation CHAR(1));',CHR(13),CHR(10));

stmt_def =                 concat('drop trigger if exists trg_',p_table_name,'_after_i on pdi_meta.',p_table_name,';',CHR(13),CHR(10));
stmt_def = concat(stmt_def,concat('drop trigger if exists trg_',p_table_name,'_after_u on pdi_meta.',p_table_name,';',CHR(13),CHR(10)));
stmt_def = concat(stmt_def,concat('drop trigger if exists trg_',p_table_name,'_after_d on pdi_meta.',p_table_name,';',CHR(13),CHR(10)));


stmt_def = concat(stmt_def
                 ,'--/',CHR(13),CHR(10)
                 ,'CREATE OR REPLACE FUNCTION pdi_meta.trg_',p_table_name,'_after_u() RETURNS trigger AS $trg_',p_table_name,'_after_u$ ',CHR(13),CHR(10)
                 ,'BEGIN',CHR(13),CHR(10)
                 ,' insert into pdi_meta.',p_table_name,'_hist (',table_columns,',hist_date_insert,dml_operation)',CHR(13), CHR(10)
                 ,' VALUES (',table_columns_new,',now(),''U'');',CHR(13),CHR(10)
                 ,' RETURN NEW; END; $trg_',p_table_name,'_after_u$ LANGUAGE plpgsql;',CHR(13),CHR(10),CHR(13),CHR(10)
                 ,'/',CHR(13),CHR(10)
                 );

stmt_def = concat(stmt_def
                 ,'--/',CHR(13),CHR(10)
                 ,'CREATE OR REPLACE FUNCTION pdi_meta.trg_',p_table_name,'_after_i() RETURNS trigger AS $trg_',p_table_name,'_after_i$ ',CHR(13),CHR(10)
                 ,'BEGIN',CHR(13),CHR(10)
                 ,' insert into pdi_meta.',p_table_name,'_hist (',table_columns,',hist_date_insert,dml_operation)',CHR(13), CHR(10)
                 ,' VALUES (',table_columns_new,',now(),''I'');',CHR(13),CHR(10)
                 ,' RETURN NEW; END; $trg_',p_table_name,'_after_i$ LANGUAGE plpgsql;',CHR(13),CHR(10),CHR(13),CHR(10)
                 ,'/',CHR(13),CHR(10)
                 );

stmt_def = concat(stmt_def
                 ,'--/',CHR(13),CHR(10)
                 ,'CREATE OR REPLACE FUNCTION pdi_meta.trg_',p_table_name,'_after_d() RETURNS trigger AS $trg_',p_table_name,'_after_d$ ',CHR(13),CHR(10)
                 ,'BEGIN',CHR(13),CHR(10)
                 ,' insert into pdi_meta.',p_table_name,'_hist (',table_columns,',hist_date_insert,dml_operation)',CHR(13), CHR(10)
                 ,' VALUES (',table_columns_old,',now(),''D'');',CHR(13),CHR(10)
                 ,' RETURN OLD; END; $trg_',p_table_name,'_after_d$ LANGUAGE plpgsql;',CHR(13),CHR(10),CHR(13),CHR(10)
                 ,'/',CHR(13),CHR(10)
                 );
                 
stmt_def = concat(stmt_def,'create trigger trg_',p_table_name,'_after_u AFTER UPDATE ON pdi_meta.',p_table_name,' FOR EACH ROW '
                      ,'EXECUTE PROCEDURE pdi_meta.trg_',p_table_name,'_after_u();',CHR(13), CHR(10));

stmt_def = concat(stmt_def,'create trigger trg_',p_table_name,'_after_i AFTER INSERT ON pdi_meta.',p_table_name,' FOR EACH ROW '
                      ,'EXECUTE PROCEDURE pdi_meta.trg_',p_table_name,'_after_i();',CHR(13), CHR(10));

stmt_def = concat(stmt_def,'create trigger trg_',p_table_name,'_after_d AFTER DELETE ON pdi_meta.',p_table_name,' FOR EACH ROW '
                      ,'EXECUTE PROCEDURE pdi_meta.trg_',p_table_name,'_after_d();',CHR(13), CHR(10));
RETURN  stmt_def;

END; $_$;


ALTER FUNCTION pdi_meta.prc_create_history_triggers(p_table_name character varying) OWNER TO pdi_meta;

--
-- Name: prc_create_new_run(integer, integer, integer); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION prc_create_new_run(p_id_rtyp integer, p_ind_restart integer, p_subruntype integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE var_last_load_dts TIMESTAMP;
BEGIN
    SELECT  load_dts INTO var_last_load_dts FROM pdi_meta.inst_actual_runs WHERE id_rtyp = p_id_rtyp;

    DELETE FROM pdi_meta.inst_actual_runs WHERE id_rtyp = p_id_rtyp;    
    IF p_ind_restart = 0 THEN INSERT INTO inst_actual_runs (  id_rtyp, id_status, date_start,   ind_restart,            load_dts ,  subruntype )
                                                    VALUES (p_id_rtyp,         1,      now(), p_ind_restart,              now()  ,p_subruntype);
                         ELSE INSERT INTO inst_actual_runs (  id_rtyp, id_status, date_start,   ind_restart,            load_dts ,  subruntype)
                                                    VALUES (p_id_rtyp,         1,      now(), p_ind_restart,    var_last_load_dts,p_subruntype);
    END IF;
END; $$;


ALTER FUNCTION pdi_meta.prc_create_new_run(p_id_rtyp integer, p_ind_restart integer, p_subruntype integer) OWNER TO pdi_meta;

--
-- Name: prc_end_run(integer, character varying, integer); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION prc_end_run(p_id_status integer, p_error_message character varying, p_id_rtyp integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE  pdi_meta.inst_actual_runs
    SET     date_end            = now()
    ,       id_status           = p_id_status
    ,       error_message       = p_error_message
    ,       duration_in_seconds = ROUND(CAST(EXTRACT(EPOCH FROM now() - date_start) AS NUMERIC),0)
    ,       duration_in_time    = CAST(SUBSTRING(CAST(now() - date_start AS VARCHAR),1,8) AS TIME)
    WHERE   id_rtyp             = p_id_rtyp;
END; $$;


ALTER FUNCTION pdi_meta.prc_end_run(p_id_status integer, p_error_message character varying, p_id_rtyp integer) OWNER TO pdi_meta;

--
-- Name: prc_log_dv_job_in_run(character varying, character varying, character varying, integer, integer, character varying, character varying, character varying, character varying, character varying, character varying, character varying, integer, integer); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE OR REPLACE FUNCTION pdi_meta.prc_log_dv_job_in_run(
    p_job                       character varying,
    p_transformation            character varying,
    p_start_end                 character varying,
    p_record_source_id          integer,
    p_source_order              integer,
    p_data_vault_object         character varying,
    p_data_vault_hub            character varying,
    p_data_vault_hub_sat        character varying,
    p_data_vault_link           character varying,
    p_data_vault_link_sat       character varying,
    p_data_vault_database_name  character varying,
    p_data_vault_object_key     character varying,
    p_etl_job_id_job            integer,
    p_etl_trf_id_batch          integer
) RETURNS void
    LANGUAGE plpgsql
AS $$
DECLARE 
    var_actual_run      INT;
    var_num_records     INT;
    var_num_errors      INT;
    var_num_processed   INT;
    stmt_def            TEXT;
BEGIN
    EXECUTE 'SELECT id_run FROM pdi_meta.inst_actual_runs WHERE id_rtyp = 1' INTO var_actual_run;

    IF p_start_end = 'start' THEN
        stmt_def := concat('select count(1) from ', p_data_vault_database_name, '.', p_data_vault_object);
        EXECUTE stmt_def INTO var_num_records;

        stmt_def := concat(
            'insert into pdi_meta.inst_run_dv_jobs ',
            '(id_run, job, transformation, date_start, record_source_id, source_order, ',
            'data_vault_object, data_vault_hub, data_vault_hub_sat, data_vault_link, data_vault_link_sat, num_records_start) ',
            'values (', coalesce(var_actual_run,0), 
            ',''', p_job, ''',''', p_transformation, ''', now(), ', p_record_source_id, 
            ',', coalesce(p_source_order,1), 
            ',''', p_data_vault_object, ''',''', coalesce(p_data_vault_hub,'null'), ''',',
            '''', coalesce(p_data_vault_hub_sat,'null'), ''',''', coalesce(p_data_vault_link,'null'), ''',',
            '''', coalesce(p_data_vault_link_sat,'null'), ''',', coalesce(var_num_records,0), ')'
        );
        stmt_def := replace(stmt_def, '''null''', 'null');
        EXECUTE stmt_def;

    ELSIF p_start_end = 'end' THEN
        -- Count records in target table
        stmt_def := concat('select count(1) from ', p_data_vault_database_name, '.', p_data_vault_object);
        EXECUTE stmt_def INTO var_num_records;

        -- Count errors
        stmt_def := concat('select count(1) from ', p_data_vault_database_name, '.', p_data_vault_object, '_err where etl_id_run is NULL');
        EXECUTE stmt_def INTO var_num_errors;

        -- FIXED: Safe lookup (returns 0 if no row)
        stmt_def := concat('select coalesce(lines_input, 0) from etl_log_transformation where id_batch = ', p_etl_trf_id_batch);
        EXECUTE stmt_def INTO var_num_processed;

        -- Safe UPDATE with COALESCE everywhere
        stmt_def := concat(
            'update pdi_meta.inst_run_dv_jobs ',
            'set num_records_end = ', var_num_records,
            ', num_errors = ', coalesce(var_num_errors, 0),
            ', date_end = now()',
            ', num_records_processed = ', coalesce(var_num_processed, 0),
            ', num_records_loaded = ', var_num_records, ' - num_records_start',
            ', duration_in_seconds = ROUND(CAST(EXTRACT(EPOCH FROM now() - date_start) AS NUMERIC), 0)',
            ', duration_in_time = CAST(SUBSTRING(CAST(now() - date_start AS VARCHAR), 1, 8) AS TIME)',
            ', etl_job_id_job = ', p_etl_job_id_job,
            ', etl_trf_id_batch = ', p_etl_trf_id_batch,
            ' where id_run = ', coalesce(var_actual_run, 0),
            ' and data_vault_object = ''', p_data_vault_object, '''',
            ' and record_source_id = ', p_record_source_id,
            ' and source_order = ', coalesce(p_source_order, 1),
            ' and date_end is null'
        );
        EXECUTE stmt_def;
    END IF;
END;
$$;


ALTER FUNCTION pdi_meta.prc_log_dv_job_in_run(p_job character varying, p_transformation character varying, p_start_end character varying, p_record_source_id integer, p_source_order integer, p_data_vault_object character varying, p_data_vault_hub character varying, p_data_vault_hub_sat character varying, p_data_vault_link character varying, p_data_vault_link_sat character varying, p_data_vault_database_name character varying, p_data_vault_object_key character varying, p_etl_job_id_job integer, p_etl_trf_id_batch integer) OWNER TO pdi_meta;

--
-- Name: prc_log_stg_file_job_in_run(character varying, character varying, character varying, integer, character varying, character varying, character varying, timestamp without time zone, integer, integer, integer, integer); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION prc_log_stg_file_job_in_run(p_job character varying, p_transformation character varying, p_start_end character varying, p_id_srcfile integer, p_staging_table_name character varying, p_staging_database_name character varying, p_source_file character varying, p_date_file_last_modified timestamp without time zone, p_num_records_file integer, p_id_rtyp integer, p_etl_job_id_job integer, p_etl_trf_id_batch integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE var_actual_run                INT;
DECLARE var_num_records               INT;
DECLARE var_max_date_start            TIMESTAMP;
DECLARE stmt_def                      TEXT;
BEGIN
       
        stmt_def = concat('SELECT id_run FROM pdi_meta.inst_actual_runs WHERE id_rtyp = ',cast(p_id_rtyp as varchar(16)));
        EXECUTE stmt_def INTO var_actual_run;
               
        stmt_def = concat('select count(1) from ',p_staging_database_name,'.',p_staging_table_name);
        EXECUTE stmt_def INTO var_num_records;
        
        IF p_start_end = 'start' THEN

        insert into pdi_meta.inst_run_stg_file_jobs (         id_run,  job,  transformation,  id_srcfile,  source_file,   target_table_name,  date_file_last_modified,date_start,  num_records_file,num_records_start)
	    values                         ( var_actual_run,p_job,p_transformation,p_id_srcfile,p_source_file,p_staging_table_name,p_date_file_last_modified,now()     ,p_num_records_file,  var_num_records);

        END IF;

        IF p_start_end = 'end' THEN

        stmt_def = concat('select max(date_start) from pdi_meta.inst_run_stg_file_jobs where  id_run = ',cast(var_actual_run as varchar(16)),' and target_table_name  = ''',p_staging_table_name,'''');
        EXECUTE stmt_def INTO var_max_date_start;
        
        stmt_def       = concat('update pdi_meta.inst_run_stg_file_jobs set num_records_end = ',var_num_records,',num_records_loaded  = ',var_num_records,' - num_records_start,date_end = ','now()'
	                       ,' ,duration_in_seconds = ROUND(CAST(EXTRACT(EPOCH FROM now() - date_start) AS NUMERIC),0)' 
	                       ,' ,duration_in_time    = CAST(SUBSTRING(CAST(now() - date_start AS VARCHAR),1,8) AS TIME)'   
	                       ,' ,etl_job_id_job      = ',p_etl_job_id_job                       
	                       ,' ,etl_trf_id_batch    = ',p_etl_trf_id_batch  
                               ,' where id_run = ',coalesce(var_actual_run,0)
                               ,' and    target_table_name = ','''',p_staging_table_name,''''
                               ,' and    date_end is null');

        EXECUTE stmt_def;       

        END IF;
END; $$;


ALTER FUNCTION pdi_meta.prc_log_stg_file_job_in_run(p_job character varying, p_transformation character varying, p_start_end character varying, p_id_srcfile integer, p_staging_table_name character varying, p_staging_database_name character varying, p_source_file character varying, p_date_file_last_modified timestamp without time zone, p_num_records_file integer, p_id_rtyp integer, p_etl_job_id_job integer, p_etl_trf_id_batch integer) OWNER TO pdi_meta;

--
-- Name: prc_log_stg_job_in_run(character varying, character varying, character varying, integer, character varying, character varying, character varying, character varying, character varying, character varying, integer, integer, integer); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION prc_log_stg_job_in_run(p_job character varying, p_transformation character varying, p_start_end character varying, p_record_source_id integer, p_source_table_name character varying, p_staging_table_name character varying, p_source_table_where_clause character varying, p_staging_database_name character varying, p_stg_load_from character varying, p_source_file character varying, p_id_rtyp integer, p_etl_job_id_job integer, p_etl_trf_id_batch integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE var_actual_run                INT;
DECLARE var_num_records               INT;
DECLARE var_max_date_start            VARCHAR(32);
DECLARE var_source_table_where_clause VARCHAR(512);
DECLARE var_stg_load_from             TIMESTAMP;
DECLARE stmt_def                      TEXT;
BEGIN    
        stmt_def = concat('SELECT id_run FROM pdi_meta.inst_actual_runs WHERE id_rtyp = ',p_id_rtyp);
        EXECUTE stmt_def INTO var_actual_run;
        
        SELECT CASE WHEN p_source_table_where_clause = 'NULL' THEN NULL ELSE p_source_table_where_clause        END INTO var_source_table_where_clause;
        SELECT CASE WHEN p_stg_load_from             = 'NULL' THEN NULL ELSE cast(p_stg_load_from as TIMESTAMP) END INTO var_stg_load_from;
        
        stmt_def = concat('select count(1) from ',p_staging_database_name,'.',p_staging_table_name);
        EXECUTE stmt_def INTO var_num_records;
        
        IF p_start_end = 'start' THEN

        insert into pdi_meta.inst_run_stg_jobs (         id_run,  job,  transformation,  record_source_id,  source_table_name,   target_table_name,     source_table_where_clause
                                               ,num_records_start,     stg_load_from,date_start ,  source_file)
	    values                    ( var_actual_run,p_job,p_transformation,p_record_source_id,p_source_table_name,p_staging_table_name, var_source_table_where_clause
	                                       ,  var_num_records, var_stg_load_from,     now() ,p_source_file);

        END IF;

        IF p_start_end = 'end' THEN

        stmt_def = concat('select cast(max(date_start) as varchar(32)) from pdi_meta.inst_run_stg_file_jobs where  id_run = ',var_actual_run,' and target_table_name  = ''',p_staging_table_name,'''');
        EXECUTE stmt_def INTO var_max_date_start;
        
        stmt_def       = concat('update pdi_meta.inst_run_stg_jobs set num_records_end = ',var_num_records,',num_records_loaded  = ',var_num_records,' - num_records_start,date_end = ','now()'
	                       ,' ,duration_in_seconds = ROUND(CAST(EXTRACT(EPOCH FROM now() - date_start) AS NUMERIC),0)' 
	                       ,' ,duration_in_time    = CAST(SUBSTRING(CAST(now() - date_start AS VARCHAR),1,8) AS TIME)'   
	                       ,' ,etl_job_id_job      = ',p_etl_job_id_job                       
	                       ,' ,etl_trf_id_batch    = ',p_etl_trf_id_batch  
                               ,' where id_run = ',coalesce(var_actual_run,0)
                               ,' and    target_table_name = ','''',p_staging_table_name,''''
                               ,' and    date_end is null');

        EXECUTE stmt_def;         

        END IF;
END; $$;


ALTER FUNCTION pdi_meta.prc_log_stg_job_in_run(p_job character varying, p_transformation character varying, p_start_end character varying, p_record_source_id integer, p_source_table_name character varying, p_staging_table_name character varying, p_source_table_where_clause character varying, p_staging_database_name character varying, p_stg_load_from character varying, p_source_file character varying, p_id_rtyp integer, p_etl_job_id_job integer, p_etl_trf_id_batch integer) OWNER TO pdi_meta;

--
-- Name: trg_inst_actual_runs_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_inst_actual_runs_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.inst_runs (id_run,id_rtyp,date_start,date_end,id_status,error_message,ind_restart,load_dts,duration_in_seconds,duration_in_time,subruntype)
 VALUES (NEW.id_run,NEW.id_rtyp,NEW.date_start,NEW.date_end,NEW.id_status,NEW.error_message,NEW.ind_restart,NEW.load_dts,NEW.duration_in_seconds,NEW.duration_in_time,NEW.subruntype);
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_inst_actual_runs_after_i() OWNER TO pdi_meta;

--
-- Name: trg_inst_actual_runs_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_inst_actual_runs_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
UPDATE pdi_meta.inst_runs SET id_rtyp = NEW.id_rtyp ,
date_start = NEW.date_start ,
date_end = NEW.date_end ,
id_status = NEW.id_status ,
error_message = NEW.error_message,
ind_restart = NEW.ind_restart,
load_dts = NEW.load_dts,
duration_in_seconds = NEW.duration_in_seconds,
duration_in_time = NEW.duration_in_time
WHERE id_run = NEW.id_run;
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_inst_actual_runs_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_connections_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_connections_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_connections_hist (id_connection,name,type,description,host_name,database_name,port_number,user_name,password,instance_name,hist_date_insert,dml_operation)
 VALUES (OLD.id_connection,OLD.name,OLD.type,OLD.description,OLD.host_name,OLD.database_name,OLD.port_number,OLD.user_name,OLD.password,OLD.instance_name,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_connections_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_connections_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_connections_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_connections_hist (id_connection,name,type,description,host_name,database_name,port_number,user_name,password,instance_name,hist_date_insert,dml_operation)
 VALUES (NEW.id_connection,NEW.name,NEW.type,NEW.description,NEW.host_name,NEW.database_name,NEW.port_number,NEW.user_name,NEW.password,NEW.instance_name,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_connections_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_connections_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_connections_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_connections_hist (id_connection,name,type,description,host_name,database_name,port_number,user_name,password,instance_name,hist_date_insert,dml_operation)
 VALUES (NEW.id_connection,NEW.name,NEW.type,NEW.description,NEW.host_name,NEW.database_name,NEW.port_number,NEW.user_name,NEW.password,NEW.instance_name,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_connections_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_hub_satellite_columns_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_hub_satellite_columns_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_hub_satellite_columns_hist (id_data_vault_hub_sat,attribute_number,attribute_source_column,attribute_target_column,record_source_id,ind_current,hist_date_insert,dml_operation)
 VALUES (OLD.id_data_vault_hub_sat,OLD.attribute_number,OLD.attribute_source_column,OLD.attribute_target_column,OLD.record_source_id,OLD.ind_current,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_hub_satellite_columns_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_hub_satellite_columns_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_hub_satellite_columns_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_hub_satellite_columns_hist (id_data_vault_hub_sat,attribute_number,attribute_source_column,attribute_target_column,record_source_id,ind_current,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault_hub_sat,NEW.attribute_number,NEW.attribute_source_column,NEW.attribute_target_column,NEW.record_source_id,NEW.ind_current,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_hub_satellite_columns_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_hub_satellite_columns_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_hub_satellite_columns_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_hub_satellite_columns_hist (id_data_vault_hub_sat,attribute_number,attribute_source_column,attribute_target_column,record_source_id,ind_current,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault_hub_sat,NEW.attribute_number,NEW.attribute_source_column,NEW.attribute_target_column,NEW.record_source_id,NEW.ind_current,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_hub_satellite_columns_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_hub_satellites_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_hub_satellites_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_hub_satellites_hist (id_data_vault_hub_sat,id_data_vault_hub,sat_name,description,sat_source_hub_business_key,sat_attributes,sat_attributes_concat,sat_attributes_concat_dv,record_source_id,ind_current,sat_attributes_dv,sat_key,ind_multiactive_extra_key_column,sat_multiactive_extra_key_column,sat_multiactive_extra_key_column_src,process_in_subruntypes,hist_date_insert,dml_operation)
 VALUES (OLD.id_data_vault_hub_sat,OLD.id_data_vault_hub,OLD.sat_name,OLD.description,OLD.sat_source_hub_business_key,OLD.sat_attributes,OLD.sat_attributes_concat,OLD.sat_attributes_concat_dv,OLD.record_source_id,OLD.ind_current,OLD.sat_attributes_dv,OLD.sat_key,OLD.ind_multiactive_extra_key_column,OLD.sat_multiactive_extra_key_column,OLD.sat_multiactive_extra_key_column_src,OLD.process_in_subruntypes,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_hub_satellites_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_hub_satellites_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_hub_satellites_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_hub_satellites_hist (id_data_vault_hub_sat,id_data_vault_hub,sat_name,description,sat_source_hub_business_key,sat_attributes,sat_attributes_concat,sat_attributes_concat_dv,record_source_id,ind_current,sat_attributes_dv,sat_key,ind_multiactive_extra_key_column,sat_multiactive_extra_key_column,sat_multiactive_extra_key_column_src,process_in_subruntypes,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault_hub_sat,NEW.id_data_vault_hub,NEW.sat_name,NEW.description,NEW.sat_source_hub_business_key,NEW.sat_attributes,NEW.sat_attributes_concat,NEW.sat_attributes_concat_dv,NEW.record_source_id,NEW.ind_current,NEW.sat_attributes_dv,NEW.sat_key,NEW.ind_multiactive_extra_key_column,NEW.sat_multiactive_extra_key_column,NEW.sat_multiactive_extra_key_column_src,NEW.process_in_subruntypes,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_hub_satellites_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_hub_satellites_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_hub_satellites_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_hub_satellites_hist (id_data_vault_hub_sat,id_data_vault_hub,sat_name,description,sat_source_hub_business_key,sat_attributes,sat_attributes_concat,sat_attributes_concat_dv,record_source_id,ind_current,sat_attributes_dv,sat_key,ind_multiactive_extra_key_column,sat_multiactive_extra_key_column,sat_multiactive_extra_key_column_src,process_in_subruntypes,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault_hub_sat,NEW.id_data_vault_hub,NEW.sat_name,NEW.description,NEW.sat_source_hub_business_key,NEW.sat_attributes,NEW.sat_attributes_concat,NEW.sat_attributes_concat_dv,NEW.record_source_id,NEW.ind_current,NEW.sat_attributes_dv,NEW.sat_key,NEW.ind_multiactive_extra_key_column,NEW.sat_multiactive_extra_key_column,NEW.sat_multiactive_extra_key_column_src,NEW.process_in_subruntypes,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_hub_satellites_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_hub_sources_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_hub_sources_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_hub_sources_hist (id_data_vault_hub,record_source_id,source_business_key,source_order,ind_current,ind_status_sat,source_surrogate_key,process_in_subruntypes,hist_date_insert,dml_operation)
 VALUES (OLD.id_data_vault_hub,OLD.record_source_id,OLD.source_business_key,OLD.source_order,OLD.ind_current,OLD.ind_status_sat,OLD.source_surrogate_key,OLD.process_in_subruntypes,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_hub_sources_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_hub_sources_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_hub_sources_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_hub_sources_hist (id_data_vault_hub,record_source_id,source_business_key,source_order,ind_current,ind_status_sat,source_surrogate_key,process_in_subruntypes,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault_hub,NEW.record_source_id,NEW.source_business_key,NEW.source_order,NEW.ind_current,NEW.ind_status_sat,NEW.source_surrogate_key,NEW.process_in_subruntypes,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_hub_sources_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_hub_sources_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_hub_sources_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_hub_sources_hist (id_data_vault_hub,record_source_id,source_business_key,source_order,ind_current,ind_status_sat,source_surrogate_key,process_in_subruntypes,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault_hub,NEW.record_source_id,NEW.source_business_key,NEW.source_order,NEW.ind_current,NEW.ind_status_sat,NEW.source_surrogate_key,NEW.process_in_subruntypes,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_hub_sources_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_hubs_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_hubs_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_hubs_hist (id_data_vault_hub,id_data_vault,hub_name,hub_key,hub_business_key,hub_description,ind_current,ind_last_seen_dts,hist_date_insert,dml_operation)
 VALUES (OLD.id_data_vault_hub,OLD.id_data_vault,OLD.hub_name,OLD.hub_key,OLD.hub_business_key,OLD.hub_description,OLD.ind_current,OLD.ind_last_seen_dts,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_hubs_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_hubs_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_hubs_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_hubs_hist (id_data_vault_hub,id_data_vault,hub_name,hub_key,hub_business_key,hub_description,ind_current,ind_last_seen_dts,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault_hub,NEW.id_data_vault,NEW.hub_name,NEW.hub_key,NEW.hub_business_key,NEW.hub_description,NEW.ind_current,NEW.ind_last_seen_dts,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_hubs_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_hubs_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_hubs_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_hubs_hist (id_data_vault_hub,id_data_vault,hub_name,hub_key,hub_business_key,hub_description,ind_current,ind_last_seen_dts,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault_hub,NEW.id_data_vault,NEW.hub_name,NEW.hub_key,NEW.hub_business_key,NEW.hub_description,NEW.ind_current,NEW.ind_last_seen_dts,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_hubs_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_link_attributes_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_link_attributes_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_link_attributes_hist (id_data_vault_link_attribute,id_data_vault_link,record_source_id,ind_current,link_attributes,link_attributes_concat,link_attributes_concat_dv,link_attributes_dv,hist_date_insert,dml_operation)
 VALUES (OLD.id_data_vault_link_attribute,OLD.id_data_vault_link,OLD.record_source_id,OLD.ind_current,OLD.link_attributes,OLD.link_attributes_concat,OLD.link_attributes_concat_dv,OLD.link_attributes_dv,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_link_attributes_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_link_attributes_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_link_attributes_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_link_attributes_hist (id_data_vault_link_attribute,id_data_vault_link,record_source_id,ind_current,link_attributes,link_attributes_concat,link_attributes_concat_dv,link_attributes_dv,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault_link_attribute,NEW.id_data_vault_link,NEW.record_source_id,NEW.ind_current,NEW.link_attributes,NEW.link_attributes_concat,NEW.link_attributes_concat_dv,NEW.link_attributes_dv,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_link_attributes_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_link_attributes_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_link_attributes_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_link_attributes_hist (id_data_vault_link_attribute,id_data_vault_link,record_source_id,ind_current,link_attributes,link_attributes_concat,link_attributes_concat_dv,link_attributes_dv,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault_link_attribute,NEW.id_data_vault_link,NEW.record_source_id,NEW.ind_current,NEW.link_attributes,NEW.link_attributes_concat,NEW.link_attributes_concat_dv,NEW.link_attributes_dv,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_link_attributes_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_link_satellite_columns_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_link_satellite_columns_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_link_satellite_columns_hist (id_data_vault_link_sat,attribute_number,attribute_source_column,attribute_target_column,record_source_id,ind_current,hist_date_insert,dml_operation)
 VALUES (OLD.id_data_vault_link_sat,OLD.attribute_number,OLD.attribute_source_column,OLD.attribute_target_column,OLD.record_source_id,OLD.ind_current,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_link_satellite_columns_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_link_satellite_columns_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_link_satellite_columns_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_link_satellite_columns_hist (id_data_vault_link_sat,attribute_number,attribute_source_column,attribute_target_column,record_source_id,ind_current,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault_link_sat,NEW.attribute_number,NEW.attribute_source_column,NEW.attribute_target_column,NEW.record_source_id,NEW.ind_current,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_link_satellite_columns_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_link_satellite_columns_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_link_satellite_columns_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_link_satellite_columns_hist (id_data_vault_link_sat,attribute_number,attribute_source_column,attribute_target_column,record_source_id,ind_current,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault_link_sat,NEW.attribute_number,NEW.attribute_source_column,NEW.attribute_target_column,NEW.record_source_id,NEW.ind_current,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_link_satellite_columns_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_link_satellites_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_link_satellites_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_link_satellites_hist (id_data_vault_link_sat,id_data_vault_link,sat_name,sat_key,description,sat_source_hub_1_business_key,sat_source_hub_2_business_key,sat_source_hub_3_business_key,sat_source_hub_4_business_key,sat_source_hub_5_business_key,sat_source_hub_6_business_key,sat_source_hub_7_business_key,sat_source_hub_8_business_key,sat_source_hub_9_business_key,sat_source_hub_10_business_key,sat_lnk_key_attributes_concat,sat_attributes,sat_attributes_dv,sat_attributes_concat,sat_attributes_concat_dv,record_source_id,ind_current,process_in_subruntypes,hist_date_insert,dml_operation)
 VALUES (OLD.id_data_vault_link_sat,OLD.id_data_vault_link,OLD.sat_name,OLD.sat_key,OLD.description,OLD.sat_source_hub_1_business_key,OLD.sat_source_hub_2_business_key,OLD.sat_source_hub_3_business_key,OLD.sat_source_hub_4_business_key,OLD.sat_source_hub_5_business_key,OLD.sat_source_hub_6_business_key,OLD.sat_source_hub_7_business_key,OLD.sat_source_hub_8_business_key,OLD.sat_source_hub_9_business_key,OLD.sat_source_hub_10_business_key,OLD.sat_lnk_key_attributes_concat,OLD.sat_attributes,OLD.sat_attributes_dv,OLD.sat_attributes_concat,OLD.sat_attributes_concat_dv,OLD.record_source_id,OLD.ind_current,OLD.process_in_subruntypes,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_link_satellites_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_link_satellites_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_link_satellites_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_link_satellites_hist (id_data_vault_link_sat,id_data_vault_link,sat_name,sat_key,description,sat_source_hub_1_business_key,sat_source_hub_2_business_key,sat_source_hub_3_business_key,sat_source_hub_4_business_key,sat_source_hub_5_business_key,sat_source_hub_6_business_key,sat_source_hub_7_business_key,sat_source_hub_8_business_key,sat_source_hub_9_business_key,sat_source_hub_10_business_key,sat_lnk_key_attributes_concat,sat_attributes,sat_attributes_dv,sat_attributes_concat,sat_attributes_concat_dv,record_source_id,ind_current,process_in_subruntypes,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault_link_sat,NEW.id_data_vault_link,NEW.sat_name,NEW.sat_key,NEW.description,NEW.sat_source_hub_1_business_key,NEW.sat_source_hub_2_business_key,NEW.sat_source_hub_3_business_key,NEW.sat_source_hub_4_business_key,NEW.sat_source_hub_5_business_key,NEW.sat_source_hub_6_business_key,NEW.sat_source_hub_7_business_key,NEW.sat_source_hub_8_business_key,NEW.sat_source_hub_9_business_key,NEW.sat_source_hub_10_business_key,NEW.sat_lnk_key_attributes_concat,NEW.sat_attributes,NEW.sat_attributes_dv,NEW.sat_attributes_concat,NEW.sat_attributes_concat_dv,NEW.record_source_id,NEW.ind_current,NEW.process_in_subruntypes,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_link_satellites_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_link_satellites_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_link_satellites_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_link_satellites_hist (id_data_vault_link_sat,id_data_vault_link,sat_name,sat_key,description,sat_source_hub_1_business_key,sat_source_hub_2_business_key,sat_source_hub_3_business_key,sat_source_hub_4_business_key,sat_source_hub_5_business_key,sat_source_hub_6_business_key,sat_source_hub_7_business_key,sat_source_hub_8_business_key,sat_source_hub_9_business_key,sat_source_hub_10_business_key,sat_lnk_key_attributes_concat,sat_attributes,sat_attributes_dv,sat_attributes_concat,sat_attributes_concat_dv,record_source_id,ind_current,process_in_subruntypes,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault_link_sat,NEW.id_data_vault_link,NEW.sat_name,NEW.sat_key,NEW.description,NEW.sat_source_hub_1_business_key,NEW.sat_source_hub_2_business_key,NEW.sat_source_hub_3_business_key,NEW.sat_source_hub_4_business_key,NEW.sat_source_hub_5_business_key,NEW.sat_source_hub_6_business_key,NEW.sat_source_hub_7_business_key,NEW.sat_source_hub_8_business_key,NEW.sat_source_hub_9_business_key,NEW.sat_source_hub_10_business_key,NEW.sat_lnk_key_attributes_concat,NEW.sat_attributes,NEW.sat_attributes_dv,NEW.sat_attributes_concat,NEW.sat_attributes_concat_dv,NEW.record_source_id,NEW.ind_current,NEW.process_in_subruntypes,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_link_satellites_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_link_sources_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_link_sources_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_link_sources_hist (id_data_vault_link,source_hub_1_business_key,source_hub_2_business_key,source_hub_3_business_key,source_hub_4_business_key,source_hub_5_business_key,source_hub_6_business_key,source_hub_7_business_key,source_hub_8_business_key,source_hub_9_business_key,source_hub_10_business_key,ind_current,record_source_id,source_order,ind_status_sat,process_in_subruntypes,hist_date_insert,dml_operation)
 VALUES (OLD.id_data_vault_link,OLD.source_hub_1_business_key,OLD.source_hub_2_business_key,OLD.source_hub_3_business_key,OLD.source_hub_4_business_key,OLD.source_hub_5_business_key,OLD.source_hub_6_business_key,OLD.source_hub_7_business_key,OLD.source_hub_8_business_key,OLD.source_hub_9_business_key,OLD.source_hub_10_business_key,OLD.ind_current,OLD.record_source_id,OLD.source_order,OLD.ind_status_sat,OLD.process_in_subruntypes,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_link_sources_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_link_sources_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_link_sources_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_link_sources_hist (id_data_vault_link,source_hub_1_business_key,source_hub_2_business_key,source_hub_3_business_key,source_hub_4_business_key,source_hub_5_business_key,source_hub_6_business_key,source_hub_7_business_key,source_hub_8_business_key,source_hub_9_business_key,source_hub_10_business_key,ind_current,record_source_id,source_order,ind_status_sat,process_in_subruntypes,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault_link,NEW.source_hub_1_business_key,NEW.source_hub_2_business_key,NEW.source_hub_3_business_key,NEW.source_hub_4_business_key,NEW.source_hub_5_business_key,NEW.source_hub_6_business_key,NEW.source_hub_7_business_key,NEW.source_hub_8_business_key,NEW.source_hub_9_business_key,NEW.source_hub_10_business_key,NEW.ind_current,NEW.record_source_id,NEW.source_order,NEW.ind_status_sat,NEW.process_in_subruntypes,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_link_sources_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_link_sources_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_link_sources_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_link_sources_hist (id_data_vault_link,source_hub_1_business_key,source_hub_2_business_key,source_hub_3_business_key,source_hub_4_business_key,source_hub_5_business_key,source_hub_6_business_key,source_hub_7_business_key,source_hub_8_business_key,source_hub_9_business_key,source_hub_10_business_key,ind_current,record_source_id,source_order,ind_status_sat,process_in_subruntypes,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault_link,NEW.source_hub_1_business_key,NEW.source_hub_2_business_key,NEW.source_hub_3_business_key,NEW.source_hub_4_business_key,NEW.source_hub_5_business_key,NEW.source_hub_6_business_key,NEW.source_hub_7_business_key,NEW.source_hub_8_business_key,NEW.source_hub_9_business_key,NEW.source_hub_10_business_key,NEW.ind_current,NEW.record_source_id,NEW.source_order,NEW.ind_status_sat,NEW.process_in_subruntypes,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_link_sources_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_links_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_links_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_links_hist (id_data_vault_link,id_data_vault,link_name,link_key,description,id_data_vault_hub_1,id_data_vault_hub_2,id_data_vault_hub_3,id_data_vault_hub_4,id_data_vault_hub_5,id_data_vault_hub_6,id_data_vault_hub_7,id_data_vault_hub_8,id_data_vault_hub_9,id_data_vault_hub_10,ind_current,link_hub_1_key_column,link_hub_2_key_column,link_hub_3_key_column,link_hub_4_key_column,link_hub_5_key_column,link_hub_6_key_column,link_hub_7_key_column,link_hub_8_key_column,link_hub_9_key_column,link_hub_10_key_column,lnk_cnt_hubs,lnk_ind_attributes,lnk_bk_columns,lnk_no_bk_columns,ind_last_seen_dts,lnk_group_key_column,lnk_no_group_key_columns,hist_date_insert,dml_operation)
 VALUES (OLD.id_data_vault_link,OLD.id_data_vault,OLD.link_name,OLD.link_key,OLD.description,OLD.id_data_vault_hub_1,OLD.id_data_vault_hub_2,OLD.id_data_vault_hub_3,OLD.id_data_vault_hub_4,OLD.id_data_vault_hub_5,OLD.id_data_vault_hub_6,OLD.id_data_vault_hub_7,OLD.id_data_vault_hub_8,OLD.id_data_vault_hub_9,OLD.id_data_vault_hub_10,OLD.ind_current,OLD.link_hub_1_key_column,OLD.link_hub_2_key_column,OLD.link_hub_3_key_column,OLD.link_hub_4_key_column,OLD.link_hub_5_key_column,OLD.link_hub_6_key_column,OLD.link_hub_7_key_column,OLD.link_hub_8_key_column,OLD.link_hub_9_key_column,OLD.link_hub_10_key_column,OLD.lnk_cnt_hubs,OLD.lnk_ind_attributes,OLD.lnk_bk_columns,OLD.lnk_no_bk_columns,OLD.ind_last_seen_dts,OLD.lnk_group_key_column,OLD.lnk_no_group_key_columns,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_links_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_links_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_links_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_links_hist (id_data_vault_link,id_data_vault,link_name,link_key,description,id_data_vault_hub_1,id_data_vault_hub_2,id_data_vault_hub_3,id_data_vault_hub_4,id_data_vault_hub_5,id_data_vault_hub_6,id_data_vault_hub_7,id_data_vault_hub_8,id_data_vault_hub_9,id_data_vault_hub_10,ind_current,link_hub_1_key_column,link_hub_2_key_column,link_hub_3_key_column,link_hub_4_key_column,link_hub_5_key_column,link_hub_6_key_column,link_hub_7_key_column,link_hub_8_key_column,link_hub_9_key_column,link_hub_10_key_column,lnk_cnt_hubs,lnk_ind_attributes,lnk_bk_columns,lnk_no_bk_columns,ind_last_seen_dts,lnk_group_key_column,lnk_no_group_key_columns,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault_link,NEW.id_data_vault,NEW.link_name,NEW.link_key,NEW.description,NEW.id_data_vault_hub_1,NEW.id_data_vault_hub_2,NEW.id_data_vault_hub_3,NEW.id_data_vault_hub_4,NEW.id_data_vault_hub_5,NEW.id_data_vault_hub_6,NEW.id_data_vault_hub_7,NEW.id_data_vault_hub_8,NEW.id_data_vault_hub_9,NEW.id_data_vault_hub_10,NEW.ind_current,NEW.link_hub_1_key_column,NEW.link_hub_2_key_column,NEW.link_hub_3_key_column,NEW.link_hub_4_key_column,NEW.link_hub_5_key_column,NEW.link_hub_6_key_column,NEW.link_hub_7_key_column,NEW.link_hub_8_key_column,NEW.link_hub_9_key_column,NEW.link_hub_10_key_column,NEW.lnk_cnt_hubs,NEW.lnk_ind_attributes,NEW.lnk_bk_columns,NEW.lnk_no_bk_columns,NEW.ind_last_seen_dts,NEW.lnk_group_key_column,NEW.lnk_no_group_key_columns,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_links_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vault_links_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vault_links_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vault_links_hist (id_data_vault_link,id_data_vault,link_name,link_key,description,id_data_vault_hub_1,id_data_vault_hub_2,id_data_vault_hub_3,id_data_vault_hub_4,id_data_vault_hub_5,id_data_vault_hub_6,id_data_vault_hub_7,id_data_vault_hub_8,id_data_vault_hub_9,id_data_vault_hub_10,ind_current,link_hub_1_key_column,link_hub_2_key_column,link_hub_3_key_column,link_hub_4_key_column,link_hub_5_key_column,link_hub_6_key_column,link_hub_7_key_column,link_hub_8_key_column,link_hub_9_key_column,link_hub_10_key_column,lnk_cnt_hubs,lnk_ind_attributes,lnk_bk_columns,lnk_no_bk_columns,ind_last_seen_dts,lnk_group_key_column,lnk_no_group_key_columns,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault_link,NEW.id_data_vault,NEW.link_name,NEW.link_key,NEW.description,NEW.id_data_vault_hub_1,NEW.id_data_vault_hub_2,NEW.id_data_vault_hub_3,NEW.id_data_vault_hub_4,NEW.id_data_vault_hub_5,NEW.id_data_vault_hub_6,NEW.id_data_vault_hub_7,NEW.id_data_vault_hub_8,NEW.id_data_vault_hub_9,NEW.id_data_vault_hub_10,NEW.ind_current,NEW.link_hub_1_key_column,NEW.link_hub_2_key_column,NEW.link_hub_3_key_column,NEW.link_hub_4_key_column,NEW.link_hub_5_key_column,NEW.link_hub_6_key_column,NEW.link_hub_7_key_column,NEW.link_hub_8_key_column,NEW.link_hub_9_key_column,NEW.link_hub_10_key_column,NEW.lnk_cnt_hubs,NEW.lnk_ind_attributes,NEW.lnk_bk_columns,NEW.lnk_no_bk_columns,NEW.ind_last_seen_dts,NEW.lnk_group_key_column,NEW.lnk_no_group_key_columns,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vault_links_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vaults_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vaults_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vaults_hist (id_data_vault,data_vault_name,data_vault_description,ind_current,hist_date_insert,dml_operation)
 VALUES (OLD.id_data_vault,OLD.data_vault_name,OLD.data_vault_description,OLD.ind_current,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vaults_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vaults_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vaults_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vaults_hist (id_data_vault,data_vault_name,data_vault_description,ind_current,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault,NEW.data_vault_name,NEW.data_vault_description,NEW.ind_current,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vaults_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_data_vaults_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_data_vaults_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_data_vaults_hist (id_data_vault,data_vault_name,data_vault_description,ind_current,hist_date_insert,dml_operation)
 VALUES (NEW.id_data_vault,NEW.data_vault_name,NEW.data_vault_description,NEW.ind_current,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_data_vaults_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_jobs_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_jobs_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_jobs_hist (job,repodir,id_prcstg,ind_current,hist_date_insert,dml_operation)
 VALUES (OLD.job,OLD.repodir,OLD.id_prcstg,OLD.ind_current,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_jobs_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_jobs_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_jobs_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_jobs_hist (job,repodir,id_prcstg,ind_current,hist_date_insert,dml_operation)
 VALUES (NEW.job,NEW.repodir,NEW.id_prcstg,NEW.ind_current,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_jobs_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_jobs_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_jobs_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_jobs_hist (job,repodir,id_prcstg,ind_current,hist_date_insert,dml_operation)
 VALUES (NEW.job,NEW.repodir,NEW.id_prcstg,NEW.ind_current,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_jobs_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_jobs_in_jobs_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_jobs_in_jobs_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_jobs_in_jobs_hist (job,parent_job,ind_current,processing_order,hist_date_insert,dml_operation)
 VALUES (OLD.job,OLD.parent_job,OLD.ind_current,OLD.processing_order,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_jobs_in_jobs_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_jobs_in_jobs_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_jobs_in_jobs_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_jobs_in_jobs_hist (job,parent_job,ind_current,processing_order,hist_date_insert,dml_operation)
 VALUES (NEW.job,NEW.parent_job,NEW.ind_current,NEW.processing_order,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_jobs_in_jobs_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_jobs_in_jobs_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_jobs_in_jobs_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_jobs_in_jobs_hist (job,parent_job,ind_current,processing_order,hist_date_insert,dml_operation)
 VALUES (NEW.job,NEW.parent_job,NEW.ind_current,NEW.processing_order,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_jobs_in_jobs_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_processing_stages_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_processing_stages_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_processing_stages_hist (id_prcstg,description,hist_date_insert,dml_operation)
 VALUES (OLD.id_prcstg,OLD.description,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_processing_stages_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_processing_stages_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_processing_stages_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_processing_stages_hist (id_prcstg,description,hist_date_insert,dml_operation)
 VALUES (NEW.id_prcstg,NEW.description,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_processing_stages_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_processing_stages_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_processing_stages_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_processing_stages_hist (id_prcstg,description,hist_date_insert,dml_operation)
 VALUES (NEW.id_prcstg,NEW.description,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_processing_stages_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_runtypes_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_runtypes_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_runtypes_hist (id_rtyp,description,hist_date_insert,dml_operation)
 VALUES (OLD.id_rtyp,OLD.description,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_runtypes_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_runtypes_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_runtypes_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_runtypes_hist (id_rtyp,description,hist_date_insert,dml_operation)
 VALUES (NEW.id_rtyp,NEW.description,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_runtypes_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_runtypes_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_runtypes_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_runtypes_hist (id_rtyp,description,hist_date_insert,dml_operation)
 VALUES (NEW.id_rtyp,NEW.description,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_runtypes_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_source_file_columns_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_source_file_columns_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_source_file_columns_hist (id_srcfile,column_name,column_type,column_format,column_length,column_precision,column_currency,column_decimal,column_group,column_trimtype,column_position,hist_date_insert,dml_operation)
 VALUES (OLD.id_srcfile,OLD.column_name,OLD.column_type,OLD.column_format,OLD.column_length,OLD.column_precision,OLD.column_currency,OLD.column_decimal,OLD.column_group,OLD.column_trimtype,OLD.column_position,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_source_file_columns_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_source_file_columns_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_source_file_columns_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_source_file_columns_hist (id_srcfile,column_name,column_type,column_format,column_length,column_precision,column_currency,column_decimal,column_group,column_trimtype,column_position,hist_date_insert,dml_operation)
 VALUES (NEW.id_srcfile,NEW.column_name,NEW.column_type,NEW.column_format,NEW.column_length,NEW.column_precision,NEW.column_currency,NEW.column_decimal,NEW.column_group,NEW.column_trimtype,NEW.column_position,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_source_file_columns_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_source_file_columns_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_source_file_columns_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_source_file_columns_hist (id_srcfile,column_name,column_type,column_format,column_length,column_precision,column_currency,column_decimal,column_group,column_trimtype,column_position,hist_date_insert,dml_operation)
 VALUES (NEW.id_srcfile,NEW.column_name,NEW.column_type,NEW.column_format,NEW.column_length,NEW.column_precision,NEW.column_currency,NEW.column_decimal,NEW.column_group,NEW.column_trimtype,NEW.column_position,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_source_file_columns_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_source_file_directories_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_source_file_directories_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_source_file_directories_hist (id_srcfile_directory,id_srcsys,file_directory,description,file_directory_archive,hist_date_insert,dml_operation)
 VALUES (OLD.id_srcfile_directory,OLD.id_srcsys,OLD.file_directory,OLD.description,OLD.file_directory_archive,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_source_file_directories_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_source_file_directories_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_source_file_directories_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_source_file_directories_hist (id_srcfile_directory,id_srcsys,file_directory,description,file_directory_archive,hist_date_insert,dml_operation)
 VALUES (NEW.id_srcfile_directory,NEW.id_srcsys,NEW.file_directory,NEW.description,NEW.file_directory_archive,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_source_file_directories_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_source_file_directories_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_source_file_directories_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_source_file_directories_hist (id_srcfile_directory,id_srcsys,file_directory,description,file_directory_archive,hist_date_insert,dml_operation)
 VALUES (NEW.id_srcfile_directory,NEW.id_srcsys,NEW.file_directory,NEW.description,NEW.file_directory_archive,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_source_file_directories_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_source_files_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_source_files_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_source_files_hist (id_srcfile,id_srcfile_directory,file_name,staging_table_name,ind_current,file_type,delimiter,enclosure,header_row_present,file_encoding,process_in_subruntypes,hist_date_insert,dml_operation)
 VALUES (OLD.id_srcfile,OLD.id_srcfile_directory,OLD.file_name,OLD.staging_table_name,OLD.ind_current,OLD.file_type,OLD.delimiter,OLD.enclosure,OLD.header_row_present,OLD.file_encoding,OLD.process_in_subruntypes,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_source_files_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_source_files_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_source_files_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_source_files_hist (id_srcfile,id_srcfile_directory,file_name,staging_table_name,ind_current,file_type,delimiter,enclosure,header_row_present,file_encoding,process_in_subruntypes,hist_date_insert,dml_operation)
 VALUES (NEW.id_srcfile,NEW.id_srcfile_directory,NEW.file_name,NEW.staging_table_name,NEW.ind_current,NEW.file_type,NEW.delimiter,NEW.enclosure,NEW.header_row_present,NEW.file_encoding,NEW.process_in_subruntypes,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_source_files_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_source_files_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_source_files_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_source_files_hist (id_srcfile,id_srcfile_directory,file_name,staging_table_name,ind_current,file_type,delimiter,enclosure,header_row_present,file_encoding,process_in_subruntypes,hist_date_insert,dml_operation)
 VALUES (NEW.id_srcfile,NEW.id_srcfile_directory,NEW.file_name,NEW.staging_table_name,NEW.ind_current,NEW.file_type,NEW.delimiter,NEW.enclosure,NEW.header_row_present,NEW.file_encoding,NEW.process_in_subruntypes,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_source_files_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_source_systems_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_source_systems_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_source_systems_hist (id_srcsys,cod_srcsys,description,id_source_connection,id_staging_connection,staging_days_to_load_default,ind_archive_staging_tables,hist_date_insert,dml_operation)
 VALUES (OLD.id_srcsys,OLD.cod_srcsys,OLD.description,OLD.id_source_connection,OLD.id_staging_connection,OLD.staging_days_to_load_default,OLD.ind_archive_staging_tables,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_source_systems_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_source_systems_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_source_systems_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_source_systems_hist (id_srcsys,cod_srcsys,description,id_source_connection,id_staging_connection,staging_days_to_load_default,ind_archive_staging_tables,hist_date_insert,dml_operation)
 VALUES (NEW.id_srcsys,NEW.cod_srcsys,NEW.description,NEW.id_source_connection,NEW.id_staging_connection,NEW.staging_days_to_load_default,NEW.ind_archive_staging_tables,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_source_systems_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_source_systems_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_source_systems_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_source_systems_hist (id_srcsys,cod_srcsys,description,id_source_connection,id_staging_connection,staging_days_to_load_default,ind_archive_staging_tables,hist_date_insert,dml_operation)
 VALUES (NEW.id_srcsys,NEW.cod_srcsys,NEW.description,NEW.id_source_connection,NEW.id_staging_connection,NEW.staging_days_to_load_default,NEW.ind_archive_staging_tables,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_source_systems_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_source_tables_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_source_tables_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_source_tables_hist (id_srctab,id_srcsys,table_name,description,staging_table_name,ind_stage_this_table,ind_staging_is_incremental,increment_date_column,staging_load_group_order,staging_sql_override,process_in_subruntypes,hist_date_insert,dml_operation)
 VALUES (OLD.id_srctab,OLD.id_srcsys,OLD.table_name,OLD.description,OLD.staging_table_name,OLD.ind_stage_this_table,OLD.ind_staging_is_incremental,OLD.increment_date_column,OLD.staging_load_group_order,OLD.staging_sql_override,OLD.process_in_subruntypes,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_source_tables_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_source_tables_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_source_tables_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_source_tables_hist (id_srctab,id_srcsys,table_name,description,staging_table_name,ind_stage_this_table,ind_staging_is_incremental,increment_date_column,staging_load_group_order,staging_sql_override,process_in_subruntypes,hist_date_insert,dml_operation)
 VALUES (NEW.id_srctab,NEW.id_srcsys,NEW.table_name,NEW.description,NEW.staging_table_name,NEW.ind_stage_this_table,NEW.ind_staging_is_incremental,NEW.increment_date_column,NEW.staging_load_group_order,NEW.staging_sql_override,NEW.process_in_subruntypes,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_source_tables_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_source_tables_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_source_tables_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_source_tables_hist (id_srctab,id_srcsys,table_name,description,staging_table_name,ind_stage_this_table,ind_staging_is_incremental,increment_date_column,staging_load_group_order,staging_sql_override,process_in_subruntypes,hist_date_insert,dml_operation)
 VALUES (NEW.id_srctab,NEW.id_srcsys,NEW.table_name,NEW.description,NEW.staging_table_name,NEW.ind_stage_this_table,NEW.ind_staging_is_incremental,NEW.increment_date_column,NEW.staging_load_group_order,NEW.staging_sql_override,NEW.process_in_subruntypes,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_source_tables_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_source_tables_staging_load_from_overrule_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_source_tables_staging_load_from_overrule_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_source_tables_staging_load_from_overrule_hist (id_srcsys,table_name,staging_load_from_overrule,hist_date_insert,dml_operation)
 VALUES (OLD.id_srcsys,OLD.table_name,OLD.staging_load_from_overrule,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_source_tables_staging_load_from_overrule_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_source_tables_staging_load_from_overrule_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_source_tables_staging_load_from_overrule_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_source_tables_staging_load_from_overrule_hist (id_srcsys,table_name,staging_load_from_overrule,hist_date_insert,dml_operation)
 VALUES (NEW.id_srcsys,NEW.table_name,NEW.staging_load_from_overrule,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_source_tables_staging_load_from_overrule_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_source_tables_staging_load_from_overrule_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_source_tables_staging_load_from_overrule_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_source_tables_staging_load_from_overrule_hist (id_srcsys,table_name,staging_load_from_overrule,hist_date_insert,dml_operation)
 VALUES (NEW.id_srcsys,NEW.table_name,NEW.staging_load_from_overrule,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_source_tables_staging_load_from_overrule_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_statuses_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_statuses_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_statuses_hist (id_status,description,hist_date_insert,dml_operation)
 VALUES (OLD.id_status,OLD.description,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_statuses_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_statuses_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_statuses_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_statuses_hist (id_status,description,hist_date_insert,dml_operation)
 VALUES (NEW.id_status,NEW.description,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_statuses_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_statuses_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_statuses_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_statuses_hist (id_status,description,hist_date_insert,dml_operation)
 VALUES (NEW.id_status,NEW.description,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_statuses_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_system_parameters_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_system_parameters_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_system_parameters_hist (parameter_name,parameter_value_varchar,parameter_value_TIMESTAMP,parameter_value_numeric,description,hist_date_insert,dml_operation)
 VALUES (OLD.parameter_name,OLD.parameter_value_varchar,OLD.parameter_value_TIMESTAMP,OLD.parameter_value_numeric,OLD.description,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_system_parameters_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_system_parameters_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_system_parameters_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_system_parameters_hist (parameter_name,parameter_value_varchar,parameter_value_TIMESTAMP,parameter_value_numeric,description,hist_date_insert,dml_operation)
 VALUES (NEW.parameter_name,NEW.parameter_value_varchar,NEW.parameter_value_TIMESTAMP,NEW.parameter_value_numeric,NEW.description,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_system_parameters_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_system_parameters_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_system_parameters_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_system_parameters_hist (parameter_name,parameter_value_varchar,parameter_value_TIMESTAMP,parameter_value_numeric,description,hist_date_insert,dml_operation)
 VALUES (NEW.parameter_name,NEW.parameter_value_varchar,NEW.parameter_value_TIMESTAMP,NEW.parameter_value_numeric,NEW.description,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_system_parameters_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_transformation_parameters_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_transformation_parameters_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_transformation_parameters_hist (transformation,parameter_name,parameter_value_varchar,parameter_value_datetime,parameter_value_numeric,description,parameter_order,hist_date_insert,dml_operation)
 VALUES (OLD.transformation,OLD.parameter_name,OLD.parameter_value_varchar,OLD.parameter_value_datetime,OLD.parameter_value_numeric,OLD.description,OLD.parameter_order,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_transformation_parameters_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_transformation_parameters_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_transformation_parameters_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_transformation_parameters_hist (transformation,parameter_name,parameter_value_varchar,parameter_value_datetime,parameter_value_numeric,description,parameter_order,hist_date_insert,dml_operation)
 VALUES (NEW.transformation,NEW.parameter_name,NEW.parameter_value_varchar,NEW.parameter_value_datetime,NEW.parameter_value_numeric,NEW.description,NEW.parameter_order,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_transformation_parameters_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_transformation_parameters_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_transformation_parameters_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_transformation_parameters_hist (transformation,parameter_name,parameter_value_varchar,parameter_value_datetime,parameter_value_numeric,description,parameter_order,hist_date_insert,dml_operation)
 VALUES (NEW.transformation,NEW.parameter_name,NEW.parameter_value_varchar,NEW.parameter_value_datetime,NEW.parameter_value_numeric,NEW.description,NEW.parameter_order,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_transformation_parameters_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_transformations_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_transformations_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_transformations_hist (transformation,id_prcstg,ind_current,repodir,hist_date_insert,dml_operation)
 VALUES (OLD.transformation,OLD.id_prcstg,OLD.ind_current,OLD.repodir,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_transformations_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_transformations_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_transformations_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_transformations_hist (transformation,id_prcstg,ind_current,repodir,hist_date_insert,dml_operation)
 VALUES (NEW.transformation,NEW.id_prcstg,NEW.ind_current,NEW.repodir,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_transformations_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_transformations_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_transformations_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_transformations_hist (transformation,id_prcstg,ind_current,repodir,hist_date_insert,dml_operation)
 VALUES (NEW.transformation,NEW.id_prcstg,NEW.ind_current,NEW.repodir,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_transformations_after_u() OWNER TO pdi_meta;

--
-- Name: trg_ref_transformations_in_jobs_after_d(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_transformations_in_jobs_after_d() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_transformations_in_jobs_hist (job,transformation,ind_current,processing_order,hist_date_insert,dml_operation)
 VALUES (OLD.job,OLD.transformation,OLD.ind_current,OLD.processing_order,now(),'D');
 RETURN OLD; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_transformations_in_jobs_after_d() OWNER TO pdi_meta;

--
-- Name: trg_ref_transformations_in_jobs_after_i(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_transformations_in_jobs_after_i() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_transformations_in_jobs_hist (job,transformation,ind_current,processing_order,hist_date_insert,dml_operation)
 VALUES (NEW.job,NEW.transformation,NEW.ind_current,NEW.processing_order,now(),'I');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_transformations_in_jobs_after_i() OWNER TO pdi_meta;

--
-- Name: trg_ref_transformations_in_jobs_after_u(); Type: FUNCTION; Schema: pdi_meta; Owner: pdi_meta
--

CREATE FUNCTION trg_ref_transformations_in_jobs_after_u() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ 
BEGIN
 insert into pdi_meta.ref_transformations_in_jobs_hist (job,transformation,ind_current,processing_order,hist_date_insert,dml_operation)
 VALUES (NEW.job,NEW.transformation,NEW.ind_current,NEW.processing_order,now(),'U');
 RETURN NEW; END; $$;


ALTER FUNCTION pdi_meta.trg_ref_transformations_in_jobs_after_u() OWNER TO pdi_meta;

SET default_tablespace = '';

SET default_with_oids = false;


--
-- Name: adm_database_table_sizes; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE adm_database_table_sizes (
    table_schema character varying(128) NOT NULL,
    table_name character varying(128) NOT NULL,
    date_checked timestamp without time zone NOT NULL,
    id_run_checked integer,
    data_mb numeric(18,2) NOT NULL,
    index_mb numeric(18,2) NOT NULL
);


ALTER TABLE adm_database_table_sizes OWNER TO pdi_meta;

--
-- Name: adm_database_table_sizes_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE adm_database_table_sizes_hist (
    table_schema character varying(128) NOT NULL,
    table_name character varying(128) NOT NULL,
    date_checked timestamp without time zone NOT NULL,
    id_run_checked integer,
    data_mb numeric(18,2) NOT NULL,
    index_mb numeric(18,2) NOT NULL
);


ALTER TABLE adm_database_table_sizes_hist OWNER TO pdi_meta;

--
-- Name: etl_log_channel; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE etl_log_channel (
    "ID_BATCH" integer,
    "CHANNEL_ID" character varying(255),
    "LOG_DATE" timestamp without time zone,
    "LOGGING_OBJECT_TYPE" character varying(255),
    "OBJECT_NAME" character varying(255),
    "OBJECT_COPY" character varying(255),
    "REPOSITORY_DIRECTORY" character varying(255),
    "FILENAME" character varying(255),
    "OBJECT_ID" character varying(255),
    "OBJECT_REVISION" character varying(255),
    "PARENT_CHANNEL_ID" character varying(255),
    "ROOT_CHANNEL_ID" character varying(255)
);


ALTER TABLE etl_log_channel OWNER TO pdi_meta;

--
-- Name: etl_log_counter; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE etl_log_counter (
    "ID" integer NOT NULL,
    "NAME" character varying(100)
);


ALTER TABLE etl_log_counter OWNER TO pdi_meta;

--
-- Name: etl_log_counter_ID_seq; Type: SEQUENCE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE SEQUENCE "etl_log_counter_ID_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE "etl_log_counter_ID_seq" OWNER TO pdi_meta;

--
-- Name: etl_log_counter_ID_seq; Type: SEQUENCE OWNED BY; Schema: pdi_meta; Owner: pdi_meta
--

ALTER SEQUENCE "etl_log_counter_ID_seq" OWNED BY etl_log_counter."ID";


--
-- Name: etl_log_job; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE etl_log_job (
    id_job integer,
    channel_id character varying(255),
    jobname character varying(255),
    status character varying(15),
    lines_read bigint,
    lines_written bigint,
    lines_updated bigint,
    lines_input bigint,
    lines_output bigint,
    lines_rejected bigint,
    errors bigint,
    startdate timestamp without time zone,
    enddate timestamp without time zone,
    logdate timestamp without time zone,
    depdate timestamp without time zone,
    replaydate timestamp without time zone,
    log_field text
);


ALTER TABLE etl_log_job OWNER TO pdi_meta;

--
-- Name: etl_log_job_entry; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE etl_log_job_entry (
    "ID_BATCH" integer,
    "CHANNEL_ID" character varying(255),
    "LOG_DATE" timestamp without time zone,
    "TRANSNAME" character varying(255),
    "STEPNAME" character varying(255),
    "LINES_READ" bigint,
    "LINES_WRITTEN" bigint,
    "LINES_UPDATED" bigint,
    "LINES_INPUT" bigint,
    "LINES_OUTPUT" bigint,
    "LINES_REJECTED" bigint,
    "ERRORS" bigint,
    "RESULT" character(1),
    "NR_RESULT_ROWS" bigint,
    "NR_RESULT_FILES" bigint,
    "LOG_FIELD" text
);


ALTER TABLE etl_log_job_entry OWNER TO pdi_meta;

--
-- Name: etl_log_transformation; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE etl_log_transformation (
    id_batch integer,
    channel_id character varying(255),
    transname character varying(255),
    status character varying(15),
    lines_read bigint,
    lines_written bigint,
    lines_updated bigint,
    lines_input bigint,
    lines_output bigint,
    lines_rejected bigint,
    errors bigint,
    startdate timestamp without time zone,
    enddate timestamp without time zone,
    logdate timestamp without time zone,
    depdate timestamp without time zone,
    replaydate timestamp without time zone,
    log_field text
);


ALTER TABLE etl_log_transformation OWNER TO pdi_meta;

--
-- Name: etl_log_transformation_step; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE etl_log_transformation_step (
    "ID_BATCH" integer,
    "CHANNEL_ID" character varying(255),
    "LOG_DATE" timestamp without time zone,
    "TRANSNAME" character varying(255),
    "STEPNAME" character varying(255),
    "STEP_COPY" integer,
    "LINES_READ" bigint,
    "LINES_WRITTEN" bigint,
    "LINES_UPDATED" bigint,
    "LINES_INPUT" bigint,
    "LINES_OUTPUT" bigint,
    "LINES_REJECTED" bigint,
    "ERRORS" bigint,
    "LOG_FIELD" text
);


ALTER TABLE etl_log_transformation_step OWNER TO pdi_meta;

--
-- Name: etl_log_transformation_step_performance; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE etl_log_transformation_step_performance (
    "ID_BATCH" integer,
    "SEQ_NR" integer,
    "LOGDATE" timestamp without time zone,
    "TRANSNAME" character varying(255),
    "STEPNAME" character varying(255),
    "STEP_COPY" integer,
    "LINES_READ" bigint,
    "LINES_WRITTEN" bigint,
    "LINES_UPDATED" bigint,
    "LINES_INPUT" bigint,
    "LINES_OUTPUT" bigint,
    "LINES_REJECTED" bigint,
    "ERRORS" bigint,
    "INPUT_BUFFER_ROWS" bigint,
    "OUTPUT_BUFFER_ROWS" bigint
);


ALTER TABLE etl_log_transformation_step_performance OWNER TO pdi_meta;

--
-- Name: inst_actual_runs; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE inst_actual_runs (
    id_run integer NOT NULL,
    id_rtyp integer,
    date_start timestamp without time zone,
    date_end timestamp without time zone,
    id_status integer,
    error_message character varying(256),
    ind_restart integer DEFAULT 0,
    load_dts timestamp without time zone,
    duration_in_seconds integer,
    duration_in_time time without time zone,
    subruntype integer
);


ALTER TABLE inst_actual_runs OWNER TO pdi_meta;

--
-- Name: inst_actual_runs_id_run_seq; Type: SEQUENCE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE SEQUENCE inst_actual_runs_id_run_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE inst_actual_runs_id_run_seq OWNER TO pdi_meta;

--
-- Name: inst_actual_runs_id_run_seq; Type: SEQUENCE OWNED BY; Schema: pdi_meta; Owner: pdi_meta
--

ALTER SEQUENCE inst_actual_runs_id_run_seq OWNED BY inst_actual_runs.id_run;


--
-- Name: inst_run_dv_jobs; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE inst_run_dv_jobs (
    id_run integer NOT NULL,
    job character varying(128) NOT NULL,
    transformation character varying(128) NOT NULL,
    data_vault_object character varying(128) NOT NULL,
    record_source_id integer NOT NULL,
    source_order integer DEFAULT 1 NOT NULL,
    data_vault_hub character varying(128),
    data_vault_hub_sat character varying(128),
    data_vault_link character varying(128),
    data_vault_link_sat character varying(128),
    date_start timestamp without time zone NOT NULL,
    date_end timestamp without time zone,
    num_records_processed integer,
    num_records_start integer,
    num_records_end integer,
    num_errors integer,
    duration_in_seconds integer,
    duration_in_time time without time zone,
    num_records_loaded integer,
    etl_trf_id_batch integer,
    etl_job_id_job integer
);


ALTER TABLE inst_run_dv_jobs OWNER TO pdi_meta;

--
-- Name: inst_run_parameters; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE inst_run_parameters (
    id_run integer NOT NULL,
    parameter_naam character varying(128) NOT NULL,
    parameter_waarde_varchar character varying(128),
    "parameter_waarde_TIMESTAMP" timestamp without time zone,
    parameter_waarde_numeric numeric(12,2),
    etl_id_job integer,
    etl_id_batch integer,
    etl_datum_insert timestamp without time zone
);


ALTER TABLE inst_run_parameters OWNER TO pdi_meta;

--
-- Name: inst_run_source_files; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE inst_run_source_files (
    id_run integer NOT NULL,
    id_srcfile integer NOT NULL,
    source_file character varying(256),
    date_file_last_modified timestamp without time zone,
    date_start timestamp without time zone NOT NULL,
    date_end timestamp without time zone,
    num_records_file integer,
    num_records_table integer
);


ALTER TABLE inst_run_source_files OWNER TO pdi_meta;

--
-- Name: inst_run_stg_file_jobs; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE inst_run_stg_file_jobs (
    id_run integer NOT NULL,
    job character varying(128),
    transformation character varying(128),
    id_srcfile integer NOT NULL,
    source_file character varying(256),
    target_table_name character varying(128),
    date_file_last_modified timestamp without time zone,
    date_start timestamp without time zone NOT NULL,
    date_end timestamp without time zone,
    duration_in_seconds integer,
    duration_in_time time without time zone,
    num_records_file integer,
    num_records_start integer,
    num_records_end integer,
    num_records_loaded integer,
    etl_trf_id_batch integer,
    etl_job_id_job integer
);


ALTER TABLE inst_run_stg_file_jobs OWNER TO pdi_meta;

--
-- Name: inst_run_stg_jobs; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE inst_run_stg_jobs (
    id_run integer NOT NULL,
    job character varying(128),
    transformation character varying(128),
    record_source_id integer,
    source_file character varying(256),
    source_table_name character varying(128),
    target_table_name character varying(128) NOT NULL,
    source_table_where_clause character varying(512),
    stg_load_from timestamp without time zone,
    date_start timestamp without time zone NOT NULL,
    date_end timestamp without time zone,
    duration_in_seconds integer,
    duration_in_time time without time zone,
    num_records_start integer,
    num_records_end integer,
    num_records_loaded integer,
    etl_trf_id_batch integer,
    etl_job_id_job integer
);


ALTER TABLE inst_run_stg_jobs OWNER TO pdi_meta;

--
-- Name: inst_run_transformations; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE inst_run_transformations (
    id_run integer,
    transformation character varying(128),
    etl_id_job integer,
    etl_id_batch integer,
    etl_date_insert timestamp without time zone
);


ALTER TABLE inst_run_transformations OWNER TO pdi_meta;

--
-- Name: inst_runs; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE inst_runs (
    id_run integer NOT NULL,
    id_rtyp integer,
    date_start timestamp without time zone,
    date_end timestamp without time zone,
    id_status integer,
    error_message character varying(256),
    ind_restart integer DEFAULT 0,
    load_dts timestamp without time zone,
    duration_in_seconds integer,
    duration_in_time time without time zone,
    subruntype integer
);


ALTER TABLE inst_runs OWNER TO pdi_meta;

--
-- Name: ref_connections; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_connections (
    id_connection integer NOT NULL,
    name character varying(64),
    type character varying(64),
    description character varying(256),
    host_name character varying(256),
    database_name character varying(256),
    port_number integer,
    user_name character varying(128),
    password character varying(128),
    instance_name character varying(256)
);


ALTER TABLE ref_connections OWNER TO pdi_meta;

--
-- Name: ref_connections_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_connections_hist (
    id_connection integer NOT NULL,
    hist_date_insert timestamp without time zone NOT NULL,
    name character varying(64),
    type character varying(64),
    description character varying(256),
    host_name character varying(256),
    database_name character varying(256),
    port_number integer,
    user_name character varying(128),
    password character varying(128),
    instance_name character varying(256),
    dml_operation character(1)
);


ALTER TABLE ref_connections_hist OWNER TO pdi_meta;

--
-- Name: ref_data_vault_hub_satellite_columns; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vault_hub_satellite_columns (
    id_data_vault_hub_sat integer NOT NULL,
    attribute_number integer NOT NULL,
    attribute_source_column character varying(128),
    attribute_target_column character varying(128),
    record_source_id integer,
    ind_current integer
);


ALTER TABLE ref_data_vault_hub_satellite_columns OWNER TO pdi_meta;

--
-- Name: ref_data_vault_hub_satellite_columns_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vault_hub_satellite_columns_hist (
    id_data_vault_hub_sat integer NOT NULL,
    attribute_number integer NOT NULL,
    attribute_source_column character varying(128),
    attribute_target_column character varying(128),
    record_source_id integer,
    ind_current integer,
    hist_date_insert timestamp without time zone,
    dml_operation character(1)
);


ALTER TABLE ref_data_vault_hub_satellite_columns_hist OWNER TO pdi_meta;

--
-- Name: ref_data_vault_hub_satellites; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vault_hub_satellites (
    id_data_vault_hub_sat integer NOT NULL,
    id_data_vault_hub integer,
    sat_name character varying(128),
    description character varying(128),
    sat_source_hub_business_key character varying(128),
    sat_attributes text,
    sat_attributes_concat text,
    sat_attributes_concat_dv text,
    record_source_id integer,
    ind_current integer,
    sat_attributes_dv text,
    sat_key character varying(128),
    ind_multiactive_extra_key_column integer DEFAULT 0,
    sat_multiactive_extra_key_column character varying(128),
    sat_multiactive_extra_key_column_src character varying(128),
    process_in_subruntypes character varying(128)
);


ALTER TABLE ref_data_vault_hub_satellites OWNER TO pdi_meta;

--
-- Name: ref_data_vault_hub_satellites_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vault_hub_satellites_hist (
    id_data_vault_hub_sat integer NOT NULL,
    hist_date_insert timestamp without time zone NOT NULL,
    id_data_vault_hub integer,
    sat_name character varying(128),
    description character varying(128),
    sat_source_hub_business_key character varying(128),
    sat_attributes text,
    sat_attributes_concat text,
    sat_attributes_concat_dv text,
    record_source_id integer,
    ind_current integer,
    sat_attributes_dv text,
    sat_key character varying(128),
    dml_operation character(1),
    ind_multiactive_extra_key_column integer DEFAULT 0,
    sat_multiactive_extra_key_column character varying(128),
    sat_multiactive_extra_key_column_src character varying(128),
    process_in_subruntypes character varying(128)
);


ALTER TABLE ref_data_vault_hub_satellites_hist OWNER TO pdi_meta;

--
-- Name: ref_data_vault_hub_satellites_id_data_vault_hub_sat_seq; Type: SEQUENCE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE SEQUENCE ref_data_vault_hub_satellites_id_data_vault_hub_sat_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE ref_data_vault_hub_satellites_id_data_vault_hub_sat_seq OWNER TO pdi_meta;

--
-- Name: ref_data_vault_hub_satellites_id_data_vault_hub_sat_seq; Type: SEQUENCE OWNED BY; Schema: pdi_meta; Owner: pdi_meta
--

ALTER SEQUENCE ref_data_vault_hub_satellites_id_data_vault_hub_sat_seq OWNED BY ref_data_vault_hub_satellites.id_data_vault_hub_sat;


--
-- Name: ref_data_vault_hub_sources; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vault_hub_sources (
    id_data_vault_hub integer NOT NULL,
    record_source_id integer NOT NULL,
    source_business_key character varying(128) NOT NULL,
    source_order integer NOT NULL,
    ind_current integer,
    ind_status_sat integer,
    source_surrogate_key character varying(128),
    process_in_subruntypes character varying(128),
    source_hash_key character varying(100)
);


ALTER TABLE ref_data_vault_hub_sources OWNER TO pdi_meta;

--
-- Name: ref_data_vault_hub_sources_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vault_hub_sources_hist (
    id_data_vault_hub integer NOT NULL,
    record_source_id integer NOT NULL,
    hist_date_insert timestamp without time zone NOT NULL,
    source_business_key character varying(128) NOT NULL,
    source_order integer NOT NULL,
    ind_current integer,
    dml_operation character(1),
    ind_status_sat integer,
    source_surrogate_key character varying(128),
    process_in_subruntypes character varying(128),
    source_hash_key character varying(100)
);


ALTER TABLE ref_data_vault_hub_sources_hist OWNER TO pdi_meta;

--
-- Name: ref_data_vault_hubs; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vault_hubs (
    id_data_vault_hub integer NOT NULL,
    id_data_vault integer NOT NULL,
    hub_name character varying(128),
    hub_key character varying(128),
    hub_business_key character varying(128),
    hub_description character varying(128),
    ind_current integer,
    ind_last_seen_dts integer DEFAULT 0
);


ALTER TABLE ref_data_vault_hubs OWNER TO pdi_meta;

--
-- Name: ref_data_vault_hubs_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vault_hubs_hist (
    id_data_vault_hub integer NOT NULL,
    hist_date_insert timestamp without time zone NOT NULL,
    id_data_vault integer NOT NULL,
    hub_name character varying(128),
    hub_key character varying(128),
    hub_business_key character varying(128),
    hub_description character varying(128),
    ind_current integer,
    dml_operation character(1),
    ind_last_seen_dts integer DEFAULT 0
);


ALTER TABLE ref_data_vault_hubs_hist OWNER TO pdi_meta;

--
-- Name: ref_data_vault_hubs_id_data_vault_hub_seq; Type: SEQUENCE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE SEQUENCE ref_data_vault_hubs_id_data_vault_hub_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE ref_data_vault_hubs_id_data_vault_hub_seq OWNER TO pdi_meta;

--
-- Name: ref_data_vault_hubs_id_data_vault_hub_seq; Type: SEQUENCE OWNED BY; Schema: pdi_meta; Owner: pdi_meta
--

ALTER SEQUENCE ref_data_vault_hubs_id_data_vault_hub_seq OWNED BY ref_data_vault_hubs.id_data_vault_hub;


--
-- Name: ref_data_vault_link_attributes; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vault_link_attributes (
    id_data_vault_link_attribute integer NOT NULL,
    id_data_vault_link integer,
    record_source_id integer,
    ind_current integer,
    link_attributes text,
    link_attributes_concat text,
    link_attributes_concat_dv text,
    link_attributes_dv text
);


ALTER TABLE ref_data_vault_link_attributes OWNER TO pdi_meta;

--
-- Name: ref_data_vault_link_attributes_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vault_link_attributes_hist (
    id_data_vault_link_attribute integer NOT NULL,
    hist_date_insert timestamp without time zone NOT NULL,
    id_data_vault_link integer,
    record_source_id integer,
    ind_current integer,
    link_attributes text,
    link_attributes_concat text,
    link_attributes_concat_dv text,
    link_attributes_dv text,
    dml_operation character(1)
);


ALTER TABLE ref_data_vault_link_attributes_hist OWNER TO pdi_meta;

--
-- Name: ref_data_vault_link_attributes_id_data_vault_link_attribute_seq; Type: SEQUENCE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE SEQUENCE ref_data_vault_link_attributes_id_data_vault_link_attribute_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE ref_data_vault_link_attributes_id_data_vault_link_attribute_seq OWNER TO pdi_meta;

--
-- Name: ref_data_vault_link_attributes_id_data_vault_link_attribute_seq; Type: SEQUENCE OWNED BY; Schema: pdi_meta; Owner: pdi_meta
--

ALTER SEQUENCE ref_data_vault_link_attributes_id_data_vault_link_attribute_seq OWNED BY ref_data_vault_link_attributes.id_data_vault_link_attribute;


--
-- Name: ref_data_vault_link_satellite_columns; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vault_link_satellite_columns (
    id_data_vault_link_sat integer NOT NULL,
    attribute_number integer NOT NULL,
    attribute_source_column character varying(128),
    attribute_target_column character varying(128),
    record_source_id integer,
    ind_current integer
);


ALTER TABLE ref_data_vault_link_satellite_columns OWNER TO pdi_meta;

--
-- Name: ref_data_vault_link_satellite_columns_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vault_link_satellite_columns_hist (
    id_data_vault_link_sat integer NOT NULL,
    attribute_number integer NOT NULL,
    attribute_source_column character varying(128),
    attribute_target_column character varying(128),
    record_source_id integer,
    ind_current integer,
    hist_date_insert timestamp without time zone,
    dml_operation character(1)
);


ALTER TABLE ref_data_vault_link_satellite_columns_hist OWNER TO pdi_meta;

--
-- Name: ref_data_vault_link_satellites; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vault_link_satellites (
    id_data_vault_link_sat integer NOT NULL,
    id_data_vault_link integer,
    sat_name character varying(128),
    sat_key character varying(128),
    description character varying(128),
    sat_source_hub_1_business_key character varying(128),
    sat_source_hub_2_business_key character varying(128),
    sat_source_hub_3_business_key character varying(128),
    sat_source_hub_4_business_key character varying(128),
    sat_source_hub_5_business_key character varying(128),
    sat_source_hub_6_business_key character varying(128),
    sat_source_hub_7_business_key character varying(128),
    sat_source_hub_8_business_key character varying(128),
    sat_source_hub_9_business_key character varying(128),
    sat_source_hub_10_business_key character varying(128),
    sat_lnk_key_attributes_concat text,
    sat_attributes text,
    sat_attributes_dv text,
    sat_attributes_concat text,
    sat_attributes_concat_dv text,
    record_source_id integer,
    ind_current integer,
    process_in_subruntypes character varying(128)
);


ALTER TABLE ref_data_vault_link_satellites OWNER TO pdi_meta;

--
-- Name: ref_data_vault_link_satellites_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vault_link_satellites_hist (
    id_data_vault_link_sat integer NOT NULL,
    id_data_vault_link integer,
    hist_date_insert timestamp without time zone NOT NULL,
    sat_name character varying(128),
    sat_key character varying(128),
    description character varying(128),
    sat_source_hub_1_business_key character varying(128),
    sat_source_hub_2_business_key character varying(128),
    sat_source_hub_3_business_key character varying(128),
    sat_source_hub_4_business_key character varying(128),
    sat_source_hub_5_business_key character varying(128),
    sat_source_hub_6_business_key character varying(128),
    sat_source_hub_7_business_key character varying(128),
    sat_source_hub_8_business_key character varying(128),
    sat_source_hub_9_business_key character varying(128),
    sat_source_hub_10_business_key character varying(128),
    sat_lnk_key_attributes_concat text,
    sat_attributes text,
    sat_attributes_dv text,
    sat_attributes_concat text,
    sat_attributes_concat_dv text,
    record_source_id integer,
    ind_current integer,
    dml_operation character(1),
    process_in_subruntypes character varying(128)
);


ALTER TABLE ref_data_vault_link_satellites_hist OWNER TO pdi_meta;

--
-- Name: ref_data_vault_link_satellites_id_data_vault_link_sat_seq; Type: SEQUENCE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE SEQUENCE ref_data_vault_link_satellites_id_data_vault_link_sat_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE ref_data_vault_link_satellites_id_data_vault_link_sat_seq OWNER TO pdi_meta;

--
-- Name: ref_data_vault_link_satellites_id_data_vault_link_sat_seq; Type: SEQUENCE OWNED BY; Schema: pdi_meta; Owner: pdi_meta
--

ALTER SEQUENCE ref_data_vault_link_satellites_id_data_vault_link_sat_seq OWNED BY ref_data_vault_link_satellites.id_data_vault_link_sat;


--
-- Name: ref_data_vault_link_sources; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vault_link_sources (
    id_data_vault_link integer NOT NULL,
    source_hub_1_business_key character varying(128),
    source_hub_2_business_key character varying(128),
    source_hub_3_business_key character varying(128),
    source_hub_4_business_key character varying(128),
    source_hub_5_business_key character varying(128),
    source_hub_6_business_key character varying(128),
    source_hub_7_business_key character varying(128),
    source_hub_8_business_key character varying(128),
    source_hub_9_business_key character varying(128),
    source_hub_10_business_key character varying(128),
    ind_current integer,
    record_source_id integer DEFAULT 0 NOT NULL,
    source_order integer,
    ind_status_sat integer,
    process_in_subruntypes character varying(128)
);


ALTER TABLE ref_data_vault_link_sources OWNER TO pdi_meta;

--
-- Name: ref_data_vault_link_sources_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vault_link_sources_hist (
    id_data_vault_link integer NOT NULL,
    hist_date_insert timestamp without time zone NOT NULL,
    source_hub_1_business_key character varying(128),
    source_hub_2_business_key character varying(128),
    source_hub_3_business_key character varying(128),
    source_hub_4_business_key character varying(128),
    source_hub_5_business_key character varying(128),
    source_hub_6_business_key character varying(128),
    source_hub_7_business_key character varying(128),
    source_hub_8_business_key character varying(128),
    source_hub_9_business_key character varying(128),
    source_hub_10_business_key character varying(128),
    ind_current integer,
    record_source_id integer DEFAULT 0 NOT NULL,
    source_order integer DEFAULT 0 NOT NULL,
    dml_operation character(1),
    ind_status_sat integer,
    process_in_subruntypes character varying(128)
);


ALTER TABLE ref_data_vault_link_sources_hist OWNER TO pdi_meta;

--
-- Name: ref_data_vault_links; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vault_links (
    id_data_vault_link integer NOT NULL,
    id_data_vault integer NOT NULL,
    link_name character varying(128),
    link_key character varying(128),
    description character varying(128),
    id_data_vault_hub_1 integer,
    id_data_vault_hub_2 integer,
    id_data_vault_hub_3 integer,
    id_data_vault_hub_4 integer,
    id_data_vault_hub_5 integer,
    id_data_vault_hub_6 integer,
    id_data_vault_hub_7 integer,
    id_data_vault_hub_8 integer,
    id_data_vault_hub_9 integer,
    id_data_vault_hub_10 integer,
    ind_current integer,
    link_hub_1_key_column character varying(128),
    link_hub_2_key_column character varying(128),
    link_hub_3_key_column character varying(128),
    link_hub_4_key_column character varying(128),
    link_hub_5_key_column character varying(128),
    link_hub_6_key_column character varying(128),
    link_hub_7_key_column character varying(128),
    link_hub_8_key_column character varying(128),
    link_hub_9_key_column character varying(128),
    link_hub_10_key_column character varying(128),
    lnk_cnt_hubs integer,
    lnk_ind_attributes integer,
    lnk_bk_columns character varying(256),
    lnk_no_bk_columns character varying(256),
    ind_last_seen_dts integer DEFAULT 0,
    lnk_group_key_column character varying(256),
    lnk_no_group_key_columns character varying(256)
);


ALTER TABLE ref_data_vault_links OWNER TO pdi_meta;

--
-- Name: ref_data_vault_links_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vault_links_hist (
    id_data_vault_link integer NOT NULL,
    id_data_vault integer NOT NULL,
    hist_date_insert timestamp without time zone NOT NULL,
    link_name character varying(128),
    link_key character varying(128),
    description character varying(128),
    id_data_vault_hub_1 integer,
    id_data_vault_hub_2 integer,
    id_data_vault_hub_3 integer,
    id_data_vault_hub_4 integer,
    id_data_vault_hub_5 integer,
    id_data_vault_hub_6 integer,
    id_data_vault_hub_7 integer,
    id_data_vault_hub_8 integer,
    id_data_vault_hub_9 integer,
    id_data_vault_hub_10 integer,
    ind_current integer,
    link_hub_1_key_column character varying(128),
    link_hub_2_key_column character varying(128),
    link_hub_3_key_column character varying(128),
    link_hub_4_key_column character varying(128),
    link_hub_5_key_column character varying(128),
    link_hub_6_key_column character varying(128),
    link_hub_7_key_column character varying(128),
    link_hub_8_key_column character varying(128),
    link_hub_9_key_column character varying(128),
    link_hub_10_key_column character varying(128),
    lnk_cnt_hubs integer,
    lnk_ind_attributes integer,
    dml_operation character(1),
    lnk_bk_columns character varying(256),
    lnk_no_bk_columns character varying(256),
    ind_last_seen_dts integer DEFAULT 0,
    lnk_group_key_column character varying(256),
    lnk_no_group_key_columns character varying(256)
);


ALTER TABLE ref_data_vault_links_hist OWNER TO pdi_meta;

--
-- Name: ref_data_vault_links_id_data_vault_link_seq; Type: SEQUENCE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE SEQUENCE ref_data_vault_links_id_data_vault_link_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE ref_data_vault_links_id_data_vault_link_seq OWNER TO pdi_meta;

--
-- Name: ref_data_vault_links_id_data_vault_link_seq; Type: SEQUENCE OWNED BY; Schema: pdi_meta; Owner: pdi_meta
--

ALTER SEQUENCE ref_data_vault_links_id_data_vault_link_seq OWNED BY ref_data_vault_links.id_data_vault_link;


--
-- Name: ref_data_vault_objects_in_subruntypes; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vault_objects_in_subruntypes (
    id_data_vault integer DEFAULT 0 NOT NULL,
    data_vault_object_type character varying(128) NOT NULL,
    data_vault_object_name character varying(128) NOT NULL,
    source_system character varying(128) NOT NULL,
    source_table character varying(128) NOT NULL,
    source_order integer DEFAULT 0 NOT NULL,
    ind_status_sat integer,
    ind_validity_sat integer,
    subruntype integer DEFAULT 0 NOT NULL
);


ALTER TABLE ref_data_vault_objects_in_subruntypes OWNER TO pdi_meta;

--
-- Name: ref_data_vaults; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vaults (
    id_data_vault integer NOT NULL,
    data_vault_name character varying(128),
    data_vault_description character varying(512),
    ind_current integer NOT NULL
);


ALTER TABLE ref_data_vaults OWNER TO pdi_meta;

--
-- Name: ref_data_vaults_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_data_vaults_hist (
    id_data_vault integer NOT NULL,
    hist_date_insert timestamp without time zone NOT NULL,
    data_vault_name character varying(128),
    data_vault_description character varying(512),
    ind_current integer NOT NULL,
    dml_operation character(1)
);


ALTER TABLE ref_data_vaults_hist OWNER TO pdi_meta;

--
-- Name: ref_jobs; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_jobs (
    job character varying(128) NOT NULL,
    repodir character varying(512),
    id_prcstg integer,
    ind_current integer NOT NULL
);


ALTER TABLE ref_jobs OWNER TO pdi_meta;

--
-- Name: ref_jobs_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_jobs_hist (
    job character varying(128) NOT NULL,
    repodir character varying(512),
    id_prcstg integer,
    ind_current integer NOT NULL,
    hist_date_insert timestamp without time zone NOT NULL,
    dml_operation character(1)
);


ALTER TABLE ref_jobs_hist OWNER TO pdi_meta;

--
-- Name: ref_jobs_in_jobs; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_jobs_in_jobs (
    job character varying(128) NOT NULL,
    parent_job character varying(128) NOT NULL,
    ind_current integer NOT NULL,
    processing_order integer
);


ALTER TABLE ref_jobs_in_jobs OWNER TO pdi_meta;

--
-- Name: ref_jobs_in_jobs_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_jobs_in_jobs_hist (
    job character varying(128) NOT NULL,
    parent_job character varying(128) NOT NULL,
    ind_current integer NOT NULL,
    processing_order integer,
    hist_date_insert timestamp without time zone NOT NULL,
    dml_operation character(1)
);


ALTER TABLE ref_jobs_in_jobs_hist OWNER TO pdi_meta;

--
-- Name: ref_processing_stages; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_processing_stages (
    id_prcstg integer NOT NULL,
    description character varying(128)
);


ALTER TABLE ref_processing_stages OWNER TO pdi_meta;

--
-- Name: ref_processing_stages_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_processing_stages_hist (
    id_prcstg integer NOT NULL,
    hist_date_insert timestamp without time zone NOT NULL,
    description character varying(128),
    dml_operation character(1)
);


ALTER TABLE ref_processing_stages_hist OWNER TO pdi_meta;

--
-- Name: ref_runtypes; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_runtypes (
    id_rtyp integer NOT NULL,
    description character varying(128)
);


ALTER TABLE ref_runtypes OWNER TO pdi_meta;

--
-- Name: ref_runtypes_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_runtypes_hist (
    id_rtyp integer NOT NULL,
    hist_date_insert timestamp without time zone NOT NULL,
    description character varying(128),
    dml_operation character(1)
);


ALTER TABLE ref_runtypes_hist OWNER TO pdi_meta;

--
-- Name: ref_source_file_columns; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_source_file_columns (
    id_srcfile integer DEFAULT 0 NOT NULL,
    column_name character varying(128) NOT NULL,
    column_type character varying(128),
    column_format character varying(128),
    column_length character varying(128),
    column_precision character varying(128),
    column_currency character varying(128),
    column_decimal character varying(128),
    column_group character varying(128),
    column_trimtype character varying(128),
    column_position integer
);


ALTER TABLE ref_source_file_columns OWNER TO pdi_meta;

--
-- Name: ref_source_file_columns_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_source_file_columns_hist (
    id_srcfile integer DEFAULT 0 NOT NULL,
    hist_date_insert timestamp without time zone NOT NULL,
    column_name character varying(128) NOT NULL,
    column_type character varying(128),
    column_format character varying(128),
    column_length character varying(128),
    column_precision character varying(128),
    column_currency character varying(128),
    column_decimal character varying(128),
    column_group character varying(128),
    column_trimtype character varying(128),
    column_position integer,
    dml_operation character(1)
);


ALTER TABLE ref_source_file_columns_hist OWNER TO pdi_meta;

--
-- Name: ref_source_file_directories; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_source_file_directories (
    id_srcfile_directory integer NOT NULL,
    id_srcsys integer NOT NULL,
    file_directory character varying(256),
    description character varying(256),
    file_directory_archive character varying(256)
);


ALTER TABLE ref_source_file_directories OWNER TO pdi_meta;

--
-- Name: ref_source_file_directories_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_source_file_directories_hist (
    id_srcfile_directory integer NOT NULL,
    hist_date_insert timestamp without time zone NOT NULL,
    id_srcsys integer NOT NULL,
    file_directory character varying(256),
    description character varying(256),
    file_directory_archive character varying(256),
    dml_operation character(1)
);


ALTER TABLE ref_source_file_directories_hist OWNER TO pdi_meta;

--
-- Name: ref_source_files; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_source_files (
    id_srcfile integer NOT NULL,
    id_srcfile_directory integer NOT NULL,
    file_name character varying(256),
    staging_table_name character varying(128),
    ind_current integer,
    file_type character varying(8),
    delimiter character varying(4),
    enclosure character varying(4),
    header_row_present character varying(1),
    file_encoding character varying(128),
    process_in_subruntypes character varying(128)
);


ALTER TABLE ref_source_files OWNER TO pdi_meta;

--
-- Name: ref_source_files_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_source_files_hist (
    id_srcfile integer NOT NULL,
    hist_date_insert timestamp without time zone NOT NULL,
    id_srcfile_directory integer NOT NULL,
    file_name character varying(256),
    staging_table_name character varying(128),
    ind_current integer,
    file_type character varying(8),
    delimiter character varying(4),
    enclosure character varying(4),
    header_row_present character varying(1),
    file_encoding character varying(128),
    dml_operation character(1),
    process_in_subruntypes character varying(128)
);


ALTER TABLE ref_source_files_hist OWNER TO pdi_meta;

--
-- Name: ref_source_files_id_srcfile_seq; Type: SEQUENCE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE SEQUENCE ref_source_files_id_srcfile_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE ref_source_files_id_srcfile_seq OWNER TO pdi_meta;

--
-- Name: ref_source_files_id_srcfile_seq; Type: SEQUENCE OWNED BY; Schema: pdi_meta; Owner: pdi_meta
--

ALTER SEQUENCE ref_source_files_id_srcfile_seq OWNED BY ref_source_files.id_srcfile;


--
-- Name: ref_source_systems; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_source_systems (
    id_srcsys integer NOT NULL,
    cod_srcsys character varying(16),
    description character varying(128),
    id_source_connection integer,
    id_staging_connection integer,
    staging_days_to_load_default integer,
    ind_archive_staging_tables integer
);


ALTER TABLE ref_source_systems OWNER TO pdi_meta;

--
-- Name: ref_source_systems_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_source_systems_hist (
    id_srcsys integer NOT NULL,
    hist_date_insert timestamp without time zone NOT NULL,
    cod_srcsys character varying(16),
    description character varying(128),
    id_source_connection integer,
    id_staging_connection integer,
    dml_operation character(1),
    staging_days_to_load_default integer,
    ind_archive_staging_tables integer
);


ALTER TABLE ref_source_systems_hist OWNER TO pdi_meta;

--
-- Name: ref_source_tables; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_source_tables (
    id_srctab integer NOT NULL,
    id_srcsys integer NOT NULL,
    table_name character varying(256),
    description character varying(128),
    staging_table_name character varying(128),
    ind_stage_this_table integer,
    ind_staging_is_incremental integer,
    increment_date_column character varying(256),
    staging_load_group_order integer,
    staging_sql_override character varying(8192),
    process_in_subruntypes character varying(128)
);


ALTER TABLE ref_source_tables OWNER TO pdi_meta;

--
-- Name: ref_source_tables_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_source_tables_hist (
    id_srctab integer NOT NULL,
    hist_date_insert timestamp without time zone NOT NULL,
    id_srcsys integer NOT NULL,
    table_name character varying(256),
    description character varying(128),
    staging_table_name character varying(128),
    dml_operation character(1),
    ind_stage_this_table integer,
    ind_staging_is_incremental integer,
    increment_date_column character varying(256),
    staging_load_group_order integer,
    staging_sql_override character varying(8192),
    process_in_subruntypes character varying(128)
);


ALTER TABLE ref_source_tables_hist OWNER TO pdi_meta;

--
-- Name: ref_source_tables_id_srctab_seq; Type: SEQUENCE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE SEQUENCE ref_source_tables_id_srctab_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE ref_source_tables_id_srctab_seq OWNER TO pdi_meta;

--
-- Name: ref_source_tables_id_srctab_seq; Type: SEQUENCE OWNED BY; Schema: pdi_meta; Owner: pdi_meta
--

ALTER SEQUENCE ref_source_tables_id_srctab_seq OWNED BY ref_source_tables.id_srctab;


--
-- Name: ref_source_tables_staging_load_from_overrule; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_source_tables_staging_load_from_overrule (
    id_srcsys integer NOT NULL,
    table_name character varying(128) NOT NULL,
    staging_load_from_overrule character varying(10)
);


ALTER TABLE ref_source_tables_staging_load_from_overrule OWNER TO pdi_meta;

--
-- Name: ref_source_tables_staging_load_from_overrule_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_source_tables_staging_load_from_overrule_hist (
    id_srcsys integer NOT NULL,
    table_name character varying(128),
    staging_load_from_overrule character varying(10),
    hist_date_insert timestamp without time zone,
    dml_operation character(1)
);


ALTER TABLE ref_source_tables_staging_load_from_overrule_hist OWNER TO pdi_meta;

--
-- Name: ref_statuses; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_statuses (
    id_status integer NOT NULL,
    description character varying(128)
);


ALTER TABLE ref_statuses OWNER TO pdi_meta;

--
-- Name: ref_statuses_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_statuses_hist (
    id_status integer NOT NULL,
    hist_date_insert timestamp without time zone NOT NULL,
    description character varying(128),
    dml_operation character(1)
);


ALTER TABLE ref_statuses_hist OWNER TO pdi_meta;

--
-- Name: ref_system_parameters; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_system_parameters (
    parameter_name character varying(128) NOT NULL,
    parameter_value_varchar character varying(128),
    "parameter_value_TIMESTAMP" timestamp without time zone,
    parameter_value_numeric numeric(12,2),
    description character varying(128)
);


ALTER TABLE ref_system_parameters OWNER TO pdi_meta;

--
-- Name: ref_system_parameters_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_system_parameters_hist (
    parameter_name character varying(128) NOT NULL,
    hist_date_insert timestamp without time zone NOT NULL,
    parameter_value_varchar character varying(128),
    "parameter_value_TIMESTAMP" timestamp without time zone,
    parameter_value_numeric numeric(12,2),
    description character varying(128),
    dml_operation character(1)
);


ALTER TABLE ref_system_parameters_hist OWNER TO pdi_meta;

--
-- Name: ref_transformation_parameters; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_transformation_parameters (
    transformation character varying(128) NOT NULL,
    parameter_name character varying(128) NOT NULL,
    parameter_value_varchar character varying(8000),
    parameter_value_datetime timestamp without time zone,
    parameter_value_numeric numeric(12,2),
    description character varying(128),
    parameter_order integer
);


ALTER TABLE ref_transformation_parameters OWNER TO pdi_meta;

--
-- Name: ref_transformation_parameters_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_transformation_parameters_hist (
    transformation character varying(128) NOT NULL,
    parameter_name character varying(128) NOT NULL,
    hist_date_insert timestamp without time zone NOT NULL,
    parameter_value_varchar character varying(8000),
    parameter_value_datetime timestamp without time zone,
    parameter_value_numeric numeric(12,2),
    description character varying(128),
    dml_operation character(1),
    parameter_order integer
);


ALTER TABLE ref_transformation_parameters_hist OWNER TO pdi_meta;

--
-- Name: ref_transformations; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_transformations (
    transformation character varying(128) NOT NULL,
    id_prcstg integer,
    ind_current integer NOT NULL,
    repodir character varying(512)
);


ALTER TABLE ref_transformations OWNER TO pdi_meta;

--
-- Name: ref_transformations_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_transformations_hist (
    transformation character varying(128) NOT NULL,
    id_prcstg integer,
    ind_current integer NOT NULL,
    repodir character varying(512),
    hist_date_insert timestamp without time zone NOT NULL,
    dml_operation character(1)
);


ALTER TABLE ref_transformations_hist OWNER TO pdi_meta;

--
-- Name: ref_transformations_in_jobs; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_transformations_in_jobs (
    job character varying(128) NOT NULL,
    transformation character varying(128) NOT NULL,
    ind_current integer NOT NULL,
    processing_order integer
);


ALTER TABLE ref_transformations_in_jobs OWNER TO pdi_meta;

--
-- Name: ref_transformations_in_jobs_hist; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE ref_transformations_in_jobs_hist (
    job character varying(128) NOT NULL,
    transformation character varying(128) NOT NULL,
    ind_current integer NOT NULL,
    processing_order integer,
    hist_date_insert timestamp without time zone NOT NULL,
    dml_operation character(1)
);


ALTER TABLE ref_transformations_in_jobs_hist OWNER TO pdi_meta;

--
-- Name: stg_management_data_vaults; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE stg_management_data_vaults (
    id_data_vault integer,
    data_vault_name character varying(128),
    data_vault_description character varying(512),
    ind_current integer
);


ALTER TABLE stg_management_data_vaults OWNER TO pdi_meta;

--
-- Name: stg_management_dv_design_errors; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE stg_management_dv_design_errors (
    sheet character varying(128),
    message character varying(1024)
);


ALTER TABLE stg_management_dv_design_errors OWNER TO pdi_meta;

--
-- Name: stg_management_hubs; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE stg_management_hubs (
    hub_name character varying(128),
    hub_description character varying(256),
    hub_key character varying(128),
    hub_business_key character varying(128),
    hub_source character varying(256),
    hub_source_business_key character varying(128),
    hub_source_order integer,
    ind_current integer,
    ind_last_seen_dts integer,
    ind_status_sat integer,
    source_surrogate_key character varying(128),
    process_in_subruntypes character varying(128),
    hub_source_hash_key character varying(100)
);


ALTER TABLE stg_management_hubs OWNER TO pdi_meta;

--
-- Name: stg_management_link_attributes; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE stg_management_link_attributes (
    link_name character varying(128),
    source_concat character varying(256),
    attribute_number integer,
    attribute_source_column character varying(128),
    attribute_target_column character varying(128),
    ind_current integer,
    sheet_row_number integer
);


ALTER TABLE stg_management_link_attributes OWNER TO pdi_meta;

--
-- Name: stg_management_link_satellites; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE stg_management_link_satellites (
    sat_name character varying(128),
    sat_key character varying(128),
    sat_description character varying(128),
    sat_link character varying(128),
    source_concat character varying(256),
    source_hub_1_hash_key character varying(128),
    source_hub_2_hash_key character varying(128),
    source_hub_3_hash_key character varying(128),
    source_hub_4_hash_key character varying(128),
    source_hub_5_hash_key character varying(128),
    source_hub_6_hash_key character varying(128),
    source_hub_7_hash_key character varying(128),
    source_hub_8_hash_key character varying(128),
    source_hub_9_hash_key character varying(128),
    source_hub_10_hash_key character varying(128),
    source_lnk_key_attribute_1 character varying(128),
    source_lnk_key_attribute_2 character varying(128),
    source_lnk_key_attribute_3 character varying(128),
    source_lnk_key_attribute_4 character varying(128),
    source_lnk_key_attribute_5 character varying(128),
    attribute_number integer,
    attribute_source_column character varying(128),
    attribute_target_column character varying(128),
    ind_current integer,
    sheet_row_number integer,
    process_in_subruntypes character varying(128)
);


ALTER TABLE stg_management_link_satellites OWNER TO pdi_meta;

--
-- Name: stg_management_links; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE stg_management_links (
    link_name character varying(128),
    link_key character varying(128),
    link_description character varying(128),
    ind_current integer,
    source_concat character varying(256),
    hub_1 character varying(128),
    link_hub_1_key_column character varying(128),
    source_hub_1_hash_key character varying(128),
    hub_2 character varying(128),
    link_hub_2_key_column character varying(128),
    source_hub_2_hash_key character varying(128),
    hub_3 character varying(128),
    link_hub_3_key_column character varying(128),
    source_hub_3_hash_key character varying(128),
    hub_4 character varying(128),
    link_hub_4_key_column character varying(128),
    source_hub_4_hash_key character varying(128),
    hub_5 character varying(128),
    link_hub_5_key_column character varying(128),
    source_hub_5_hash_key character varying(128),
    hub_6 character varying(128),
    link_hub_6_key_column character varying(128),
    source_hub_6_hash_key character varying(128),
    hub_7 character varying(128),
    link_hub_7_key_column character varying(128),
    source_hub_7_hash_key character varying(128),
    hub_8 character varying(128),
    link_hub_8_key_column character varying(128),
    source_hub_8_hash_key character varying(128),
    hub_9 character varying(128),
    link_hub_9_key_column character varying(128),
    source_hub_9_hash_key character varying(128),
    hub_10 character varying(128),
    link_hub_10_key_column character varying(128),
    source_hub_10_hash_key character varying(128),
    link_source_order integer,
    lnk_bk_columns character varying(256),
    lnk_no_bk_columns character varying(256),
    ind_last_seen_dts integer,
    ind_status_sat integer,
    lnk_group_key_column character varying(256),
    lnk_no_group_key_columns character varying(256),
    process_in_subruntypes character varying(128)
);


ALTER TABLE stg_management_links OWNER TO pdi_meta;

--
-- Name: stg_management_satellites; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE stg_management_satellites (
    sat_name character varying(128),
    sat_key character varying(128),
    sat_description character varying(128),
    sat_hub character varying(128),
    source_concat character varying(256),
    source_hub_hash_key character varying(128),
    attribute_number integer,
    attribute_source_column character varying(128),
    attribute_target_column character varying(128),
    ind_current integer,
    sheet_row_number integer,
    ind_multiactive_extra_key_column integer DEFAULT 0,
    process_in_subruntypes character varying(128)
);


ALTER TABLE stg_management_satellites OWNER TO pdi_meta;

--
-- Name: stg_management_source_systems; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE stg_management_source_systems (
    id_srcsys integer,
    cod_srcsys character varying(16),
    description character varying(128),
    source_connection character varying(128),
    staging_connection character varying(128),
    staging_days_to_load_default integer,
    ind_archive_staging_tables integer
);


ALTER TABLE stg_management_source_systems OWNER TO pdi_meta;

--
-- Name: stg_management_source_tables; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE stg_management_source_tables (
    source_system character varying(128),
    table_name character varying(128),
    table_description character varying(128),
    staging_table_name character varying(128),
    source_concat character varying(256),
    ind_stage_this_table integer,
    ind_staging_is_incremental integer,
    increment_date_column character varying(256),
    staging_load_group_order integer,
    staging_sql_override character varying(8192),
    process_in_subruntypes character varying(128)
);


ALTER TABLE stg_management_source_tables OWNER TO pdi_meta;



CREATE TABLE information_schema_tables (
	table_catalog text NULL,
	table_schema text NULL,
	table_name text NULL,
	table_type text NULL,
	self_referencing_column_name text NULL,
	reference_generation text NULL,
	user_defined_type_catalog text NULL,
	user_defined_type_schema text NULL,
	user_defined_type_name text NULL,
	is_insertable_into varchar(3) NULL,
	is_typed varchar(3) NULL,
	commit_action text NULL
);

ALTER TABLE information_schema_tables OWNER TO pdi_meta;



CREATE TABLE vw_information_schema_columns_data_vault (
	table_name text NULL,
	table_schema text NULL,
	column_name text NULL,
	ordinal_position int4 NULL,
	is_nullable varchar(3) NULL,
	data_type text NULL
);

ALTER TABLE vw_information_schema_columns_data_vault OWNER TO pdi_meta;

--
-- Name: vw_adm_database_table_sizes; Type: VIEW; Schema: pdi_meta; Owner: pdi_meta
--

CREATE VIEW vw_adm_database_table_sizes AS
 SELECT tables.table_schema,
    tables.table_name,
    now() AS date_checked,
    round(((pg_relation_size(((((tables.table_schema)::text || '.'::text) || (tables.table_name)::text))::regclass))::numeric / (1024.0 * (1024)::numeric)), 2) AS data_mb,
    round((((pg_total_relation_size(((((tables.table_schema)::text || '.'::text) || (tables.table_name)::text))::regclass) - pg_relation_size(((((tables.table_schema)::text || '.'::text) || (tables.table_name)::text))::regclass)))::numeric / (1024.0 * (1024)::numeric)), 2) AS index_mb
   FROM information_schema.tables
  WHERE ((tables.table_type)::text = 'BASE TABLE'::text);


ALTER TABLE vw_adm_database_table_sizes OWNER TO pdi_meta;

--
-- Name: vw_stg_management_link_attributes_all_columns_filled; Type: VIEW; Schema: pdi_meta; Owner: pdi_meta
--

CREATE VIEW vw_stg_management_link_attributes_all_columns_filled AS
 SELECT stg_latt_2.link_name,
    stg_latt_2.source_concat,
    stg_latt_2.ind_current,
    stg_latt.attribute_number,
    stg_latt.attribute_source_column,
    stg_latt.attribute_target_column
   FROM (stg_management_link_attributes stg_latt
     JOIN stg_management_link_attributes stg_latt_2 ON ((stg_latt_2.sheet_row_number = ( SELECT max(stg_latt_3.sheet_row_number) AS max
           FROM stg_management_link_attributes stg_latt_3
          WHERE ((stg_latt_3.sheet_row_number <= stg_latt.sheet_row_number) AND (stg_latt_3.link_name IS NOT NULL))))));


ALTER TABLE vw_stg_management_link_attributes_all_columns_filled OWNER TO pdi_meta;

--
-- Name: vw_stg_management_link_satellites_all_columns_filled; Type: VIEW; Schema: pdi_meta; Owner: pdi_meta
--

CREATE VIEW vw_stg_management_link_satellites_all_columns_filled AS
 SELECT stg_sat_2.sat_name,
    stg_sat_2.sat_key,
    stg_sat_2.sat_description,
    stg_sat_2.sat_link,
    stg_sat_2.source_concat,
    stg_sat_2.ind_current,
    stg_sat_2.source_hub_1_hash_key AS source_hub_1_business_key,
    stg_sat_2.source_hub_2_hash_key AS source_hub_2_business_key,
    stg_sat_2.source_hub_3_hash_key AS source_hub_3_business_key,
    stg_sat_2.source_hub_4_hash_key AS source_hub_4_business_key,
    stg_sat_2.source_hub_5_hash_key AS source_hub_5_business_key,
    stg_sat_2.source_hub_6_hash_key AS source_hub_6_business_key,
    stg_sat_2.source_hub_7_hash_key AS source_hub_7_business_key,
    stg_sat_2.source_hub_8_hash_key AS source_hub_8_business_key,
    stg_sat_2.source_hub_9_hash_key AS source_hub_9_business_key,
    stg_sat_2.source_hub_10_hash_key AS source_hub_10_business_key,
    stg_sat_2.source_lnk_key_attribute_1,
    stg_sat_2.source_lnk_key_attribute_2,
    stg_sat_2.source_lnk_key_attribute_3,
    stg_sat_2.source_lnk_key_attribute_4,
    stg_sat_2.source_lnk_key_attribute_5,
    stg_sat_2.process_in_subruntypes,
    stg_sat.attribute_number,
    stg_sat.attribute_source_column,
    stg_sat.attribute_target_column
   FROM (stg_management_link_satellites stg_sat
     JOIN stg_management_link_satellites stg_sat_2 ON ((stg_sat_2.sheet_row_number = ( SELECT max(stg_sat_3.sheet_row_number) AS max
           FROM stg_management_link_satellites stg_sat_3
          WHERE ((stg_sat_3.sheet_row_number <= stg_sat.sheet_row_number) AND (stg_sat_3.sat_name IS NOT NULL))))));


ALTER TABLE vw_stg_management_link_satellites_all_columns_filled OWNER TO pdi_meta;

--
-- Name: vw_stg_management_satellites_all_columns_filled; Type: VIEW; Schema: pdi_meta; Owner: pdi_meta
--

CREATE VIEW vw_stg_management_satellites_all_columns_filled AS
 SELECT stg_sat_2.sat_name,
    stg_sat_2.sat_key,
    stg_sat_2.sat_description,
    stg_sat_2.sat_hub,
    stg_sat_2.source_concat,
    stg_sat_2.ind_current,
    stg_sat_2.source_hub_hash_key AS source_hub_business_key,
    stg_sat_2.process_in_subruntypes,
    stg_sat.attribute_number,
    stg_sat.attribute_source_column,
    stg_sat.attribute_target_column,
    stg_sat.ind_multiactive_extra_key_column
   FROM (stg_management_satellites stg_sat
     JOIN stg_management_satellites stg_sat_2 ON ((stg_sat_2.sheet_row_number = ( SELECT max(stg_sat_3.sheet_row_number) AS max
           FROM stg_management_satellites stg_sat_3
          WHERE ((stg_sat_3.sheet_row_number <= stg_sat.sheet_row_number) AND (stg_sat_3.sat_name IS NOT NULL))))));


ALTER TABLE vw_stg_management_satellites_all_columns_filled OWNER TO pdi_meta;

--
-- Name: kpi_errors; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE kpi_errors (
    error character varying(512),
    error_code character varying(128),
    group_code character varying(128),
    date_log timestamp without time zone
);


ALTER TABLE kpi_errors OWNER TO pdi_meta;

--
-- Name: link_negative_count_id_seq; Type: SEQUENCE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE SEQUENCE link_negative_count_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE link_negative_count_id_seq OWNER TO pdi_meta;

--
-- Name: link_negative_count; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE link_negative_count (
    id integer NOT NULL DEFAULT nextval('link_negative_count_id_seq'::regclass),
    negative_count integer,
    table_name character varying(256),
    added_datetime timestamp without time zone
);


ALTER TABLE link_negative_count OWNER TO pdi_meta;

--
-- Name: meta_table_errors; Type: TABLE; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TABLE meta_table_errors (
    table_name character varying(256),
    row_count integer,
    process_time timestamp without time zone
);


ALTER TABLE meta_table_errors OWNER TO pdi_meta;

--
-- Name: etl_log_counter ID; Type: DEFAULT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY etl_log_counter ALTER COLUMN "ID" SET DEFAULT nextval('"etl_log_counter_ID_seq"'::regclass);


--
-- Name: inst_actual_runs id_run; Type: DEFAULT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY inst_actual_runs ALTER COLUMN id_run SET DEFAULT nextval('inst_actual_runs_id_run_seq'::regclass);


--
-- Name: link_negative_count id; Type: DEFAULT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY link_negative_count ALTER COLUMN id SET DEFAULT nextval('link_negative_count_id_seq'::regclass);


--
-- Name: ref_data_vault_hub_satellites id_data_vault_hub_sat; Type: DEFAULT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_hub_satellites ALTER COLUMN id_data_vault_hub_sat SET DEFAULT nextval('ref_data_vault_hub_satellites_id_data_vault_hub_sat_seq'::regclass);


--
-- Name: ref_data_vault_hubs id_data_vault_hub; Type: DEFAULT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_hubs ALTER COLUMN id_data_vault_hub SET DEFAULT nextval('ref_data_vault_hubs_id_data_vault_hub_seq'::regclass);


--
-- Name: ref_data_vault_link_attributes id_data_vault_link_attribute; Type: DEFAULT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_link_attributes ALTER COLUMN id_data_vault_link_attribute SET DEFAULT nextval('ref_data_vault_link_attributes_id_data_vault_link_attribute_seq'::regclass);


--
-- Name: ref_data_vault_link_satellites id_data_vault_link_sat; Type: DEFAULT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_link_satellites ALTER COLUMN id_data_vault_link_sat SET DEFAULT nextval('ref_data_vault_link_satellites_id_data_vault_link_sat_seq'::regclass);


--
-- Name: ref_data_vault_links id_data_vault_link; Type: DEFAULT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_links ALTER COLUMN id_data_vault_link SET DEFAULT nextval('ref_data_vault_links_id_data_vault_link_seq'::regclass);


--
-- Name: ref_source_files id_srcfile; Type: DEFAULT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_source_files ALTER COLUMN id_srcfile SET DEFAULT nextval('ref_source_files_id_srcfile_seq'::regclass);


--
-- Name: ref_source_tables id_srctab; Type: DEFAULT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_source_tables ALTER COLUMN id_srctab SET DEFAULT nextval('ref_source_tables_id_srctab_seq'::regclass);


--
-- Data for Name: adm_database_table_sizes; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY adm_database_table_sizes (table_schema, table_name, date_checked, id_run_checked, data_mb, index_mb) FROM stdin;
\.


--
-- Data for Name: adm_database_table_sizes_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY adm_database_table_sizes_hist (table_schema, table_name, date_checked, id_run_checked, data_mb, index_mb) FROM stdin;
\.


--
-- Data for Name: etl_log_channel; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY etl_log_channel ("ID_BATCH", "CHANNEL_ID", "LOG_DATE", "LOGGING_OBJECT_TYPE", "OBJECT_NAME", "OBJECT_COPY", "REPOSITORY_DIRECTORY", "FILENAME", "OBJECT_ID", "OBJECT_REVISION", "PARENT_CHANNEL_ID", "ROOT_CHANNEL_ID") FROM stdin;
\.


--
-- Data for Name: etl_log_counter; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY etl_log_counter ("ID", "NAME") FROM stdin;
1	LOG_TABLES
\.


--
-- Name: etl_log_counter_ID_seq; Type: SEQUENCE SET; Schema: pdi_meta; Owner: pdi_meta
--

SELECT pg_catalog.setval('"etl_log_counter_ID_seq"', 1, true);


--
-- Data for Name: etl_log_job; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY etl_log_job (id_job, channel_id, jobname, status, lines_read, lines_written, lines_updated, lines_input, lines_output, lines_rejected, errors, startdate, enddate, logdate, depdate, replaydate, log_field) FROM stdin;
\.


--
-- Data for Name: etl_log_job_entry; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY etl_log_job_entry ("ID_BATCH", "CHANNEL_ID", "LOG_DATE", "TRANSNAME", "STEPNAME", "LINES_READ", "LINES_WRITTEN", "LINES_UPDATED", "LINES_INPUT", "LINES_OUTPUT", "LINES_REJECTED", "ERRORS", "RESULT", "NR_RESULT_ROWS", "NR_RESULT_FILES", "LOG_FIELD") FROM stdin;
\.


--
-- Data for Name: etl_log_transformation; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY etl_log_transformation (id_batch, channel_id, transname, status, lines_read, lines_written, lines_updated, lines_input, lines_output, lines_rejected, errors, startdate, enddate, logdate, depdate, replaydate, log_field) FROM stdin;
\.


--
-- Data for Name: etl_log_transformation_step; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY etl_log_transformation_step ("ID_BATCH", "CHANNEL_ID", "LOG_DATE", "TRANSNAME", "STEPNAME", "STEP_COPY", "LINES_READ", "LINES_WRITTEN", "LINES_UPDATED", "LINES_INPUT", "LINES_OUTPUT", "LINES_REJECTED", "ERRORS", "LOG_FIELD") FROM stdin;
\.


--
-- Data for Name: etl_log_transformation_step_performance; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY etl_log_transformation_step_performance ("ID_BATCH", "SEQ_NR", "LOGDATE", "TRANSNAME", "STEPNAME", "STEP_COPY", "LINES_READ", "LINES_WRITTEN", "LINES_UPDATED", "LINES_INPUT", "LINES_OUTPUT", "LINES_REJECTED", "ERRORS", "INPUT_BUFFER_ROWS", "OUTPUT_BUFFER_ROWS") FROM stdin;
\.


--
-- Data for Name: inst_actual_runs; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY inst_actual_runs (id_run, id_rtyp, date_start, date_end, id_status, error_message, ind_restart, load_dts, duration_in_seconds, duration_in_time, subruntype) FROM stdin;
\.


--
-- Name: inst_actual_runs_id_run_seq; Type: SEQUENCE SET; Schema: pdi_meta; Owner: pdi_meta
--

SELECT pg_catalog.setval('inst_actual_runs_id_run_seq', 1, false);


--
-- Data for Name: inst_run_dv_jobs; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY inst_run_dv_jobs (id_run, job, transformation, data_vault_object, record_source_id, source_order, data_vault_hub, data_vault_hub_sat, data_vault_link, data_vault_link_sat, date_start, date_end, num_records_processed, num_records_start, num_records_end, num_errors, duration_in_seconds, duration_in_time, num_records_loaded, etl_trf_id_batch, etl_job_id_job) FROM stdin;
\.


--
-- Data for Name: inst_run_parameters; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY inst_run_parameters (id_run, parameter_naam, parameter_waarde_varchar, "parameter_waarde_TIMESTAMP", parameter_waarde_numeric, etl_id_job, etl_id_batch, etl_datum_insert) FROM stdin;
\.


--
-- Data for Name: inst_run_source_files; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY inst_run_source_files (id_run, id_srcfile, source_file, date_file_last_modified, date_start, date_end, num_records_file, num_records_table) FROM stdin;
\.


--
-- Data for Name: inst_run_stg_file_jobs; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY inst_run_stg_file_jobs (id_run, job, transformation, id_srcfile, source_file, target_table_name, date_file_last_modified, date_start, date_end, duration_in_seconds, duration_in_time, num_records_file, num_records_start, num_records_end, num_records_loaded, etl_trf_id_batch, etl_job_id_job) FROM stdin;
\.


--
-- Data for Name: inst_run_stg_jobs; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY inst_run_stg_jobs (id_run, job, transformation, record_source_id, source_file, source_table_name, target_table_name, source_table_where_clause, stg_load_from, date_start, date_end, duration_in_seconds, duration_in_time, num_records_start, num_records_end, num_records_loaded, etl_trf_id_batch, etl_job_id_job) FROM stdin;
\.


--
-- Data for Name: inst_run_transformations; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY inst_run_transformations (id_run, transformation, etl_id_job, etl_id_batch, etl_date_insert) FROM stdin;
\.


--
-- Data for Name: inst_runs; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY inst_runs (id_run, id_rtyp, date_start, date_end, id_status, error_message, ind_restart, load_dts, duration_in_seconds, duration_in_time, subruntype) FROM stdin;
\.


--
-- Data for Name: kpi_errors; Type: TABLE DATA; Schema: pdi_meta; Owner: Blair
--

COPY kpi_errors (error, error_code, group_code, date_log) FROM stdin;
\.


--
-- Data for Name: link_negative_count; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY link_negative_count (id, negative_count, table_name, added_datetime) FROM stdin;
\.


--
-- Name: link_negative_count_id_seq; Type: SEQUENCE SET; Schema: pdi_meta; Owner: pdi_meta
--

SELECT pg_catalog.setval('link_negative_count_id_seq', 1, false);


--
-- Data for Name: meta_table_errors; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY meta_table_errors (table_name, row_count, process_time) FROM stdin;
\.


--
-- Data for Name: ref_connections; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_connections (id_connection, name, type, description, host_name, database_name, port_number, user_name, password, instance_name) FROM stdin;
3	example_source	SQLServer	Example source database	source-db.example.internal	example_source_db	1433	example_source_user	change_me_example_password	\N
4	example_staging	PostgreSQL	Example staging database	staging-db.example.internal	example_staging_db	5432	example_staging_user	change_me_example_password	\N
\.


--
-- Data for Name: ref_connections_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_connections_hist (id_connection, hist_date_insert, name, type, description, host_name, database_name, port_number, user_name, password, instance_name, dml_operation) FROM stdin;
2	2017-02-28 14:11:35.607516	example_staging_old	PostgreSQL	Example deleted staging connection	old-staging-db.example.internal	example_staging_archive	5432	example_archive_user	change_me_example_password	\N	D
1	2017-02-28 14:11:35.607516	example_source_old	PostgreSQL	Example deleted source connection	\N	example_source_archive	\N	example_archive_user	change_me_example_password	\N	D
3	2017-02-28 14:11:35.607516	example_source	SQLServer	Example updated source database	source-db.example.internal	example_source_db	1433	example_source_user	change_me_example_password	\N	U
4	2017-02-28 14:11:35.607516	example_staging	PostgreSQL	Example updated staging database	staging-db.example.internal	example_staging_db	5432	example_staging_user	change_me_example_password	\N	U
\.


--
-- Data for Name: ref_data_vault_hub_satellite_columns; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vault_hub_satellite_columns (id_data_vault_hub_sat, attribute_number, attribute_source_column, attribute_target_column, record_source_id, ind_current) FROM stdin;
\.


--
-- Data for Name: ref_data_vault_hub_satellite_columns_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vault_hub_satellite_columns_hist (id_data_vault_hub_sat, attribute_number, attribute_source_column, attribute_target_column, record_source_id, ind_current, hist_date_insert, dml_operation) FROM stdin;
\.


--
-- Data for Name: ref_data_vault_hub_satellites; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vault_hub_satellites (id_data_vault_hub_sat, id_data_vault_hub, sat_name, description, sat_source_hub_business_key, sat_attributes, sat_attributes_concat, sat_attributes_concat_dv, record_source_id, ind_current, sat_attributes_dv, sat_key, ind_multiactive_extra_key_column, sat_multiactive_extra_key_column, sat_multiactive_extra_key_column_src, process_in_subruntypes) FROM stdin;
\.


--
-- Data for Name: ref_data_vault_hub_satellites_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vault_hub_satellites_hist (id_data_vault_hub_sat, hist_date_insert, id_data_vault_hub, sat_name, description, sat_source_hub_business_key, sat_attributes, sat_attributes_concat, sat_attributes_concat_dv, record_source_id, ind_current, sat_attributes_dv, sat_key, dml_operation, ind_multiactive_extra_key_column, sat_multiactive_extra_key_column, sat_multiactive_extra_key_column_src, process_in_subruntypes) FROM stdin;
\.


--
-- Name: ref_data_vault_hub_satellites_id_data_vault_hub_sat_seq; Type: SEQUENCE SET; Schema: pdi_meta; Owner: pdi_meta
--

SELECT pg_catalog.setval('ref_data_vault_hub_satellites_id_data_vault_hub_sat_seq', 1, false);


--
-- Data for Name: ref_data_vault_hub_sources; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vault_hub_sources (id_data_vault_hub, record_source_id, source_business_key, source_order, ind_current, ind_status_sat, source_surrogate_key, process_in_subruntypes) FROM stdin;
\.


--
-- Data for Name: ref_data_vault_hub_sources_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vault_hub_sources_hist (id_data_vault_hub, record_source_id, hist_date_insert, source_business_key, source_order, ind_current, dml_operation, ind_status_sat, source_surrogate_key, process_in_subruntypes) FROM stdin;
\.


--
-- Data for Name: ref_data_vault_hubs; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vault_hubs (id_data_vault_hub, id_data_vault, hub_name, hub_key, hub_business_key, hub_description, ind_current, ind_last_seen_dts) FROM stdin;
\.


--
-- Data for Name: ref_data_vault_hubs_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vault_hubs_hist (id_data_vault_hub, hist_date_insert, id_data_vault, hub_name, hub_key, hub_business_key, hub_description, ind_current, dml_operation, ind_last_seen_dts) FROM stdin;
\.


--
-- Name: ref_data_vault_hubs_id_data_vault_hub_seq; Type: SEQUENCE SET; Schema: pdi_meta; Owner: pdi_meta
--

SELECT pg_catalog.setval('ref_data_vault_hubs_id_data_vault_hub_seq', 1, false);


--
-- Data for Name: ref_data_vault_link_attributes; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vault_link_attributes (id_data_vault_link_attribute, id_data_vault_link, record_source_id, ind_current, link_attributes, link_attributes_concat, link_attributes_concat_dv, link_attributes_dv) FROM stdin;
\.


--
-- Data for Name: ref_data_vault_link_attributes_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vault_link_attributes_hist (id_data_vault_link_attribute, hist_date_insert, id_data_vault_link, record_source_id, ind_current, link_attributes, link_attributes_concat, link_attributes_concat_dv, link_attributes_dv, dml_operation) FROM stdin;
\.


--
-- Name: ref_data_vault_link_attributes_id_data_vault_link_attribute_seq; Type: SEQUENCE SET; Schema: pdi_meta; Owner: pdi_meta
--

SELECT pg_catalog.setval('ref_data_vault_link_attributes_id_data_vault_link_attribute_seq', 1, false);


--
-- Data for Name: ref_data_vault_link_satellite_columns; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vault_link_satellite_columns (id_data_vault_link_sat, attribute_number, attribute_source_column, attribute_target_column, record_source_id, ind_current) FROM stdin;
\.


--
-- Data for Name: ref_data_vault_link_satellite_columns_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vault_link_satellite_columns_hist (id_data_vault_link_sat, attribute_number, attribute_source_column, attribute_target_column, record_source_id, ind_current, hist_date_insert, dml_operation) FROM stdin;
\.


--
-- Data for Name: ref_data_vault_link_satellites; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vault_link_satellites (id_data_vault_link_sat, id_data_vault_link, sat_name, sat_key, description, sat_source_hub_1_business_key, sat_source_hub_2_business_key, sat_source_hub_3_business_key, sat_source_hub_4_business_key, sat_source_hub_5_business_key, sat_source_hub_6_business_key, sat_source_hub_7_business_key, sat_source_hub_8_business_key, sat_source_hub_9_business_key, sat_source_hub_10_business_key, sat_lnk_key_attributes_concat, sat_attributes, sat_attributes_dv, sat_attributes_concat, sat_attributes_concat_dv, record_source_id, ind_current, process_in_subruntypes) FROM stdin;
\.


--
-- Data for Name: ref_data_vault_link_satellites_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vault_link_satellites_hist (id_data_vault_link_sat, id_data_vault_link, hist_date_insert, sat_name, sat_key, description, sat_source_hub_1_business_key, sat_source_hub_2_business_key, sat_source_hub_3_business_key, sat_source_hub_4_business_key, sat_source_hub_5_business_key, sat_source_hub_6_business_key, sat_source_hub_7_business_key, sat_source_hub_8_business_key, sat_source_hub_9_business_key, sat_source_hub_10_business_key, sat_lnk_key_attributes_concat, sat_attributes, sat_attributes_dv, sat_attributes_concat, sat_attributes_concat_dv, record_source_id, ind_current, dml_operation, process_in_subruntypes) FROM stdin;
\.


--
-- Name: ref_data_vault_link_satellites_id_data_vault_link_sat_seq; Type: SEQUENCE SET; Schema: pdi_meta; Owner: pdi_meta
--

SELECT pg_catalog.setval('ref_data_vault_link_satellites_id_data_vault_link_sat_seq', 1, false);


--
-- Data for Name: ref_data_vault_link_sources; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vault_link_sources (id_data_vault_link, source_hub_1_business_key, source_hub_2_business_key, source_hub_3_business_key, source_hub_4_business_key, source_hub_5_business_key, source_hub_6_business_key, source_hub_7_business_key, source_hub_8_business_key, source_hub_9_business_key, source_hub_10_business_key, ind_current, record_source_id, source_order, ind_status_sat, process_in_subruntypes) FROM stdin;
\.


--
-- Data for Name: ref_data_vault_link_sources_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vault_link_sources_hist (id_data_vault_link, hist_date_insert, source_hub_1_business_key, source_hub_2_business_key, source_hub_3_business_key, source_hub_4_business_key, source_hub_5_business_key, source_hub_6_business_key, source_hub_7_business_key, source_hub_8_business_key, source_hub_9_business_key, source_hub_10_business_key, ind_current, record_source_id, source_order, dml_operation, ind_status_sat, process_in_subruntypes) FROM stdin;
\.


--
-- Data for Name: ref_data_vault_links; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vault_links (id_data_vault_link, id_data_vault, link_name, link_key, description, id_data_vault_hub_1, id_data_vault_hub_2, id_data_vault_hub_3, id_data_vault_hub_4, id_data_vault_hub_5, id_data_vault_hub_6, id_data_vault_hub_7, id_data_vault_hub_8, id_data_vault_hub_9, id_data_vault_hub_10, ind_current, link_hub_1_key_column, link_hub_2_key_column, link_hub_3_key_column, link_hub_4_key_column, link_hub_5_key_column, link_hub_6_key_column, link_hub_7_key_column, link_hub_8_key_column, link_hub_9_key_column, link_hub_10_key_column, lnk_cnt_hubs, lnk_ind_attributes, lnk_bk_columns, lnk_no_bk_columns, ind_last_seen_dts, lnk_group_key_column, lnk_no_group_key_columns) FROM stdin;
\.


--
-- Data for Name: ref_data_vault_links_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vault_links_hist (id_data_vault_link, id_data_vault, hist_date_insert, link_name, link_key, description, id_data_vault_hub_1, id_data_vault_hub_2, id_data_vault_hub_3, id_data_vault_hub_4, id_data_vault_hub_5, id_data_vault_hub_6, id_data_vault_hub_7, id_data_vault_hub_8, id_data_vault_hub_9, id_data_vault_hub_10, ind_current, link_hub_1_key_column, link_hub_2_key_column, link_hub_3_key_column, link_hub_4_key_column, link_hub_5_key_column, link_hub_6_key_column, link_hub_7_key_column, link_hub_8_key_column, link_hub_9_key_column, link_hub_10_key_column, lnk_cnt_hubs, lnk_ind_attributes, dml_operation, lnk_bk_columns, lnk_no_bk_columns, ind_last_seen_dts, lnk_group_key_column, lnk_no_group_key_columns) FROM stdin;
\.


--
-- Name: ref_data_vault_links_id_data_vault_link_seq; Type: SEQUENCE SET; Schema: pdi_meta; Owner: pdi_meta
--

SELECT pg_catalog.setval('ref_data_vault_links_id_data_vault_link_seq', 1, false);


--
-- Data for Name: ref_data_vault_objects_in_subruntypes; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vault_objects_in_subruntypes (id_data_vault, data_vault_object_type, data_vault_object_name, source_system, source_table, source_order, ind_status_sat, ind_validity_sat, subruntype) FROM stdin;
\.


--
-- Data for Name: ref_data_vaults; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vaults (id_data_vault, data_vault_name, data_vault_description, ind_current) FROM stdin;
1	Data Vault demo	Data Vault demo	1
\.


--
-- Data for Name: ref_data_vaults_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_data_vaults_hist (id_data_vault, hist_date_insert, data_vault_name, data_vault_description, ind_current, dml_operation) FROM stdin;
1	2014-12-08 22:46:25.705127	Data Vault demo	Data Vault demo	1	I
\.


--
-- Data for Name: ref_jobs; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_jobs (job, repodir, id_prcstg, ind_current) FROM stdin;
\.


--
-- Data for Name: ref_jobs_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_jobs_hist (job, repodir, id_prcstg, ind_current, hist_date_insert, dml_operation) FROM stdin;
\.


--
-- Data for Name: ref_jobs_in_jobs; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_jobs_in_jobs (job, parent_job, ind_current, processing_order) FROM stdin;
\.


--
-- Data for Name: ref_jobs_in_jobs_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_jobs_in_jobs_hist (job, parent_job, ind_current, processing_order, hist_date_insert, dml_operation) FROM stdin;
\.


--
-- Data for Name: ref_processing_stages; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_processing_stages (id_prcstg, description) FROM stdin;
0	Management
1	Extraction from source systems
2	Staging area
3	Data Vault
4	Data marts
\.


--
-- Data for Name: ref_processing_stages_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_processing_stages_hist (id_prcstg, hist_date_insert, description, dml_operation) FROM stdin;
0	2014-12-08 16:26:00.01194	Management	I
1	2014-12-08 16:26:00.017221	Extraction from source systems	I
2	2014-12-08 16:26:00.02058	Staging area	I
3	2014-12-08 16:26:00.023296	Data Vault	I
4	2014-12-08 16:26:00.026068	Data marts	I
\.


--
-- Data for Name: ref_runtypes; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_runtypes (id_rtyp, description) FROM stdin;
1	Data Vault
2	Test Staging
3	Test Staging Files
4	Staging
5	Complete run: Staging and Data Vault
6	Refresh database metrics
\.


--
-- Data for Name: ref_runtypes_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_runtypes_hist (id_rtyp, hist_date_insert, description, dml_operation) FROM stdin;
\.


--
-- Data for Name: ref_source_file_columns; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_source_file_columns (id_srcfile, column_name, column_type, column_format, column_length, column_precision, column_currency, column_decimal, column_group, column_trimtype, column_position) FROM stdin;
\.


--
-- Data for Name: ref_source_file_columns_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_source_file_columns_hist (id_srcfile, hist_date_insert, column_name, column_type, column_format, column_length, column_precision, column_currency, column_decimal, column_group, column_trimtype, column_position, dml_operation) FROM stdin;
\.


--
-- Data for Name: ref_source_file_directories; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_source_file_directories (id_srcfile_directory, id_srcsys, file_directory, description, file_directory_archive) FROM stdin;
\.


--
-- Data for Name: ref_source_file_directories_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_source_file_directories_hist (id_srcfile_directory, hist_date_insert, id_srcsys, file_directory, description, file_directory_archive, dml_operation) FROM stdin;
\.


--
-- Data for Name: ref_source_files; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_source_files (id_srcfile, id_srcfile_directory, file_name, staging_table_name, ind_current, file_type, delimiter, enclosure, header_row_present, file_encoding, process_in_subruntypes) FROM stdin;
\.


--
-- Data for Name: ref_source_files_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_source_files_hist (id_srcfile, hist_date_insert, id_srcfile_directory, file_name, staging_table_name, ind_current, file_type, delimiter, enclosure, header_row_present, file_encoding, dml_operation, process_in_subruntypes) FROM stdin;
\.


--
-- Name: ref_source_files_id_srcfile_seq; Type: SEQUENCE SET; Schema: pdi_meta; Owner: pdi_meta
--

SELECT pg_catalog.setval('ref_source_files_id_srcfile_seq', 1, false);


--
-- Data for Name: ref_source_systems; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_source_systems (id_srcsys, cod_srcsys, description, id_source_connection, id_staging_connection, staging_days_to_load_default, ind_archive_staging_tables) FROM stdin;
\.


--
-- Data for Name: ref_source_systems_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_source_systems_hist (id_srcsys, hist_date_insert, cod_srcsys, description, id_source_connection, id_staging_connection, dml_operation, staging_days_to_load_default, ind_archive_staging_tables) FROM stdin;
\.


--
-- Data for Name: ref_source_tables; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_source_tables (id_srctab, id_srcsys, table_name, description, staging_table_name, ind_stage_this_table, ind_staging_is_incremental, increment_date_column, staging_load_group_order, staging_sql_override, process_in_subruntypes) FROM stdin;
\.


--
-- Data for Name: ref_source_tables_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_source_tables_hist (id_srctab, hist_date_insert, id_srcsys, table_name, description, staging_table_name, dml_operation, ind_stage_this_table, ind_staging_is_incremental, increment_date_column, staging_load_group_order, staging_sql_override, process_in_subruntypes) FROM stdin;
\.


--
-- Name: ref_source_tables_id_srctab_seq; Type: SEQUENCE SET; Schema: pdi_meta; Owner: pdi_meta
--

SELECT pg_catalog.setval('ref_source_tables_id_srctab_seq', 1, false);


--
-- Data for Name: ref_source_tables_staging_load_from_overrule; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_source_tables_staging_load_from_overrule (id_srcsys, table_name, staging_load_from_overrule) FROM stdin;
\.


--
-- Data for Name: ref_source_tables_staging_load_from_overrule_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_source_tables_staging_load_from_overrule_hist (id_srcsys, table_name, staging_load_from_overrule, hist_date_insert, dml_operation) FROM stdin;
\.


--
-- Data for Name: ref_statuses; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_statuses (id_status, description) FROM stdin;
1	Started
2	Ended succesfully
3	Ended with errors
\.


--
-- Data for Name: ref_statuses_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_statuses_hist (id_status, hist_date_insert, description, dml_operation) FROM stdin;
1	2014-12-08 16:25:55.850496	Started	I
2	2014-12-08 16:25:55.855067	Ended succesfully	I
3	2014-12-08 16:25:55.858185	Ended with errors	I
\.


--
-- Data for Name: ref_system_parameters; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_system_parameters (parameter_name, parameter_value_varchar, "parameter_value_TIMESTAMP", parameter_value_numeric, description) FROM stdin;
\.


--
-- Data for Name: ref_system_parameters_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_system_parameters_hist (parameter_name, hist_date_insert, parameter_value_varchar, "parameter_value_TIMESTAMP", parameter_value_numeric, description, dml_operation) FROM stdin;
\.


--
-- Data for Name: ref_transformation_parameters; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_transformation_parameters (transformation, parameter_name, parameter_value_varchar, parameter_value_datetime, parameter_value_numeric, description, parameter_order) FROM stdin;
\.


--
-- Data for Name: ref_transformation_parameters_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_transformation_parameters_hist (transformation, parameter_name, hist_date_insert, parameter_value_varchar, parameter_value_datetime, parameter_value_numeric, description, dml_operation, parameter_order) FROM stdin;
\.


--
-- Data for Name: ref_transformations; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_transformations (transformation, id_prcstg, ind_current, repodir) FROM stdin;
\.


--
-- Data for Name: ref_transformations_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_transformations_hist (transformation, id_prcstg, ind_current, repodir, hist_date_insert, dml_operation) FROM stdin;
\.


--
-- Data for Name: ref_transformations_in_jobs; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_transformations_in_jobs (job, transformation, ind_current, processing_order) FROM stdin;
\.


--
-- Data for Name: ref_transformations_in_jobs_hist; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY ref_transformations_in_jobs_hist (job, transformation, ind_current, processing_order, hist_date_insert, dml_operation) FROM stdin;
\.


--
-- Data for Name: stg_management_data_vaults; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY stg_management_data_vaults (id_data_vault, data_vault_name, data_vault_description, ind_current) FROM stdin;
\.


--
-- Data for Name: stg_management_dv_design_errors; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY stg_management_dv_design_errors (sheet, message) FROM stdin;
\.


--
-- Data for Name: stg_management_hubs; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY stg_management_hubs (hub_name, hub_description, hub_key, hub_business_key, hub_source, hub_source_business_key, hub_source_order, ind_current, ind_last_seen_dts, ind_status_sat, source_surrogate_key, process_in_subruntypes) FROM stdin;
\.


--
-- Data for Name: stg_management_link_attributes; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY stg_management_link_attributes (link_name, source_concat, attribute_number, attribute_source_column, attribute_target_column, ind_current, sheet_row_number) FROM stdin;
\.


--
-- Data for Name: stg_management_link_satellites; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY stg_management_link_satellites (sat_name, sat_key, sat_description, sat_link, source_concat, source_hub_1_hash_key, source_hub_2_hash_key, source_hub_3_hash_key, source_hub_4_hash_key, source_hub_5_hash_key, source_hub_6_hash_key, source_hub_7_hash_key, source_hub_8_hash_key, source_hub_9_hash_key, source_hub_10_hash_key, source_lnk_key_attribute_1, source_lnk_key_attribute_2, source_lnk_key_attribute_3, source_lnk_key_attribute_4, source_lnk_key_attribute_5, attribute_number, attribute_source_column, attribute_target_column, ind_current, sheet_row_number, process_in_subruntypes) FROM stdin;
\.


--
-- Data for Name: stg_management_links; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY stg_management_links (link_name, link_key, link_description, ind_current, source_concat, hub_1, link_hub_1_key_column, source_hub_1_hash_key, hub_2, link_hub_2_key_column, source_hub_2_hash_key, hub_3, link_hub_3_key_column, source_hub_3_hash_key, hub_4, link_hub_4_key_column, source_hub_4_hash_key, hub_5, link_hub_5_key_column, source_hub_5_hash_key, hub_6, link_hub_6_key_column, source_hub_6_hash_key, hub_7, link_hub_7_key_column, source_hub_7_hash_key, hub_8, link_hub_8_key_column, source_hub_8_hash_key, hub_9, link_hub_9_key_column, source_hub_9_hash_key, hub_10, link_hub_10_key_column, source_hub_10_hash_key, link_source_order, lnk_bk_columns, lnk_no_bk_columns, ind_last_seen_dts, ind_status_sat, lnk_group_key_column, lnk_no_group_key_columns, process_in_subruntypes) FROM stdin;
\.


--
-- Data for Name: stg_management_satellites; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY stg_management_satellites (sat_name, sat_key, sat_description, sat_hub, source_concat, source_hub_hash_key, attribute_number, attribute_source_column, attribute_target_column, ind_current, sheet_row_number, ind_multiactive_extra_key_column, process_in_subruntypes) FROM stdin;
\.


--
-- Data for Name: stg_management_source_systems; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY stg_management_source_systems (id_srcsys, cod_srcsys, description, source_connection, staging_connection, staging_days_to_load_default, ind_archive_staging_tables) FROM stdin;
\.


--
-- Data for Name: stg_management_source_tables; Type: TABLE DATA; Schema: pdi_meta; Owner: pdi_meta
--

COPY stg_management_source_tables (source_system, table_name, table_description, staging_table_name, source_concat, ind_stage_this_table, ind_staging_is_incremental, increment_date_column, staging_load_group_order, staging_sql_override, process_in_subruntypes) FROM stdin;
\.


--
-- Name: adm_database_table_sizes pk_adm_database_table_sizes; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY adm_database_table_sizes
    ADD CONSTRAINT pk_adm_database_table_sizes PRIMARY KEY (table_schema, table_name);


--
-- Name: adm_database_table_sizes_hist pk_adm_database_table_sizes_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY adm_database_table_sizes_hist
    ADD CONSTRAINT pk_adm_database_table_sizes_hist PRIMARY KEY (table_schema, table_name, date_checked);


--
-- Name: etl_log_counter pk_etl_log_counter; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY etl_log_counter
    ADD CONSTRAINT pk_etl_log_counter PRIMARY KEY ("ID");


--
-- Name: inst_actual_runs pk_inst_actual_runs; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY inst_actual_runs
    ADD CONSTRAINT pk_inst_actual_runs PRIMARY KEY (id_run);


--
-- Name: inst_run_dv_jobs pk_inst_run_dv_jobs; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY inst_run_dv_jobs
    ADD CONSTRAINT pk_inst_run_dv_jobs PRIMARY KEY (id_run, job, transformation, data_vault_object, record_source_id, source_order, date_start);


--
-- Name: inst_run_parameters pk_inst_run_parameters; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY inst_run_parameters
    ADD CONSTRAINT pk_inst_run_parameters PRIMARY KEY (id_run, parameter_naam);


--
-- Name: inst_run_source_files pk_inst_run_source_files; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY inst_run_source_files
    ADD CONSTRAINT pk_inst_run_source_files PRIMARY KEY (id_run, id_srcfile, date_start);


--
-- Name: inst_run_stg_file_jobs pk_inst_run_stg_file_jobs; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY inst_run_stg_file_jobs
    ADD CONSTRAINT pk_inst_run_stg_file_jobs PRIMARY KEY (id_run, id_srcfile, date_start);


--
-- Name: inst_run_stg_jobs pk_inst_run_stg_jobs; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY inst_run_stg_jobs
    ADD CONSTRAINT pk_inst_run_stg_jobs PRIMARY KEY (id_run, target_table_name, date_start);


--
-- Name: inst_runs pk_inst_runs; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY inst_runs
    ADD CONSTRAINT pk_inst_runs PRIMARY KEY (id_run);


--
-- Name: ref_connections pk_ref_connections; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_connections
    ADD CONSTRAINT pk_ref_connections PRIMARY KEY (id_connection);


--
-- Name: ref_connections_hist pk_ref_connections_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_connections_hist
    ADD CONSTRAINT pk_ref_connections_hist PRIMARY KEY (id_connection, hist_date_insert);


--
-- Name: ref_data_vault_hub_satellite_columns pk_ref_data_vault_hub_satellite_columns; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_hub_satellite_columns
    ADD CONSTRAINT pk_ref_data_vault_hub_satellite_columns PRIMARY KEY (id_data_vault_hub_sat, attribute_number);


--
-- Name: ref_data_vault_hub_satellites pk_ref_data_vault_hub_satellites; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_hub_satellites
    ADD CONSTRAINT pk_ref_data_vault_hub_satellites PRIMARY KEY (id_data_vault_hub_sat);


--
-- Name: ref_data_vault_hub_satellites_hist pk_ref_data_vault_hub_satellites_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_hub_satellites_hist
    ADD CONSTRAINT pk_ref_data_vault_hub_satellites_hist PRIMARY KEY (id_data_vault_hub_sat, hist_date_insert);


--
-- Name: ref_data_vault_hub_sources pk_ref_data_vault_hub_sources; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_hub_sources
    ADD CONSTRAINT pk_ref_data_vault_hub_sources PRIMARY KEY (id_data_vault_hub, record_source_id, source_business_key);


--
-- Name: ref_data_vault_hub_sources_hist pk_ref_data_vault_hub_sources_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_hub_sources_hist
    ADD CONSTRAINT pk_ref_data_vault_hub_sources_hist PRIMARY KEY (id_data_vault_hub, record_source_id, source_business_key, hist_date_insert);


--
-- Name: ref_data_vault_hubs pk_ref_data_vault_hubs; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_hubs
    ADD CONSTRAINT pk_ref_data_vault_hubs PRIMARY KEY (id_data_vault_hub);


--
-- Name: ref_data_vault_hubs_hist pk_ref_data_vault_hubs_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_hubs_hist
    ADD CONSTRAINT pk_ref_data_vault_hubs_hist PRIMARY KEY (id_data_vault_hub, hist_date_insert);


--
-- Name: ref_data_vault_link_attributes pk_ref_data_vault_link_attributes; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_link_attributes
    ADD CONSTRAINT pk_ref_data_vault_link_attributes PRIMARY KEY (id_data_vault_link_attribute);


--
-- Name: ref_data_vault_link_attributes_hist pk_ref_data_vault_link_attributes_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_link_attributes_hist
    ADD CONSTRAINT pk_ref_data_vault_link_attributes_hist PRIMARY KEY (id_data_vault_link_attribute, hist_date_insert);


--
-- Name: ref_data_vault_link_satellite_columns pk_ref_data_vault_link_satellite_columns; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_link_satellite_columns
    ADD CONSTRAINT pk_ref_data_vault_link_satellite_columns PRIMARY KEY (id_data_vault_link_sat, attribute_number);


--
-- Name: ref_data_vault_link_satellites pk_ref_data_vault_link_satellites; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_link_satellites
    ADD CONSTRAINT pk_ref_data_vault_link_satellites PRIMARY KEY (id_data_vault_link_sat);


--
-- Name: ref_data_vault_link_satellites_hist pk_ref_data_vault_link_satellites_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_link_satellites_hist
    ADD CONSTRAINT pk_ref_data_vault_link_satellites_hist PRIMARY KEY (id_data_vault_link_sat, hist_date_insert);


--
-- Name: ref_data_vault_link_sources pk_ref_data_vault_link_sources; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_link_sources
    ADD CONSTRAINT pk_ref_data_vault_link_sources PRIMARY KEY (id_data_vault_link, record_source_id);


--
-- Name: ref_data_vault_link_sources_hist pk_ref_data_vault_link_sources_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_link_sources_hist
    ADD CONSTRAINT pk_ref_data_vault_link_sources_hist PRIMARY KEY (id_data_vault_link, record_source_id, source_order, hist_date_insert);


--
-- Name: ref_data_vault_links pk_ref_data_vault_links; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_links
    ADD CONSTRAINT pk_ref_data_vault_links PRIMARY KEY (id_data_vault_link);


--
-- Name: ref_data_vault_links_hist pk_ref_data_vault_links_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_links_hist
    ADD CONSTRAINT pk_ref_data_vault_links_hist PRIMARY KEY (id_data_vault_link, hist_date_insert);


--
-- Name: ref_data_vault_objects_in_subruntypes pk_ref_data_vault_objects_in_subruntypes; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_objects_in_subruntypes
    ADD CONSTRAINT pk_ref_data_vault_objects_in_subruntypes PRIMARY KEY (id_data_vault, data_vault_object_type, data_vault_object_name, source_system, source_table, source_order, subruntype);


--
-- Name: ref_data_vaults pk_ref_data_vaults; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vaults
    ADD CONSTRAINT pk_ref_data_vaults PRIMARY KEY (id_data_vault);


--
-- Name: ref_data_vaults_hist pk_ref_data_vaults_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vaults_hist
    ADD CONSTRAINT pk_ref_data_vaults_hist PRIMARY KEY (id_data_vault, hist_date_insert);


--
-- Name: ref_jobs pk_ref_jobs; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_jobs
    ADD CONSTRAINT pk_ref_jobs PRIMARY KEY (job);


--
-- Name: ref_jobs_hist pk_ref_jobs_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_jobs_hist
    ADD CONSTRAINT pk_ref_jobs_hist PRIMARY KEY (job, hist_date_insert);


--
-- Name: ref_jobs_in_jobs pk_ref_jobs_in_jobs; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_jobs_in_jobs
    ADD CONSTRAINT pk_ref_jobs_in_jobs PRIMARY KEY (job, parent_job);


--
-- Name: ref_jobs_in_jobs_hist pk_ref_jobs_in_jobs_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_jobs_in_jobs_hist
    ADD CONSTRAINT pk_ref_jobs_in_jobs_hist PRIMARY KEY (job, parent_job, hist_date_insert);


--
-- Name: ref_processing_stages pk_ref_processing_stages; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_processing_stages
    ADD CONSTRAINT pk_ref_processing_stages PRIMARY KEY (id_prcstg);


--
-- Name: ref_runtypes pk_ref_runtypes; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_runtypes
    ADD CONSTRAINT pk_ref_runtypes PRIMARY KEY (id_rtyp);


--
-- Name: ref_runtypes_hist pk_ref_runtypes_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_runtypes_hist
    ADD CONSTRAINT pk_ref_runtypes_hist PRIMARY KEY (id_rtyp, hist_date_insert);


--
-- Name: ref_source_file_columns pk_ref_source_file_columns; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_source_file_columns
    ADD CONSTRAINT pk_ref_source_file_columns PRIMARY KEY (id_srcfile, column_name);


--
-- Name: ref_source_file_columns_hist pk_ref_source_file_columns_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_source_file_columns_hist
    ADD CONSTRAINT pk_ref_source_file_columns_hist PRIMARY KEY (id_srcfile, column_name, hist_date_insert);


--
-- Name: ref_source_file_directories pk_ref_source_file_directories; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_source_file_directories
    ADD CONSTRAINT pk_ref_source_file_directories PRIMARY KEY (id_srcfile_directory);


--
-- Name: ref_source_file_directories_hist pk_ref_source_file_directories_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_source_file_directories_hist
    ADD CONSTRAINT pk_ref_source_file_directories_hist PRIMARY KEY (id_srcfile_directory, hist_date_insert);


--
-- Name: ref_source_files pk_ref_source_files; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_source_files
    ADD CONSTRAINT pk_ref_source_files PRIMARY KEY (id_srcfile);


--
-- Name: ref_source_files_hist pk_ref_source_files_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_source_files_hist
    ADD CONSTRAINT pk_ref_source_files_hist PRIMARY KEY (id_srcfile, hist_date_insert);


--
-- Name: ref_source_systems pk_ref_source_systems; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_source_systems
    ADD CONSTRAINT pk_ref_source_systems PRIMARY KEY (id_srcsys);


--
-- Name: ref_source_systems_hist pk_ref_source_systems_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_source_systems_hist
    ADD CONSTRAINT pk_ref_source_systems_hist PRIMARY KEY (id_srcsys, hist_date_insert);


--
-- Name: ref_source_tables pk_ref_source_tables; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_source_tables
    ADD CONSTRAINT pk_ref_source_tables PRIMARY KEY (id_srctab);


--
-- Name: ref_source_tables_hist pk_ref_source_tables_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_source_tables_hist
    ADD CONSTRAINT pk_ref_source_tables_hist PRIMARY KEY (id_srctab, hist_date_insert);


--
-- Name: ref_source_tables_staging_load_from_overrule pk_ref_source_tables_staging_load_from_overrule; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_source_tables_staging_load_from_overrule
    ADD CONSTRAINT pk_ref_source_tables_staging_load_from_overrule PRIMARY KEY (id_srcsys, table_name);


--
-- Name: ref_statuses pk_ref_statuses; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_statuses
    ADD CONSTRAINT pk_ref_statuses PRIMARY KEY (id_status);


--
-- Name: ref_statuses_hist pk_ref_statuses_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_statuses_hist
    ADD CONSTRAINT pk_ref_statuses_hist PRIMARY KEY (id_status, hist_date_insert);


--
-- Name: ref_system_parameters pk_ref_system_parameters; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_system_parameters
    ADD CONSTRAINT pk_ref_system_parameters PRIMARY KEY (parameter_name);


--
-- Name: ref_system_parameters_hist pk_ref_system_parameters_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_system_parameters_hist
    ADD CONSTRAINT pk_ref_system_parameters_hist PRIMARY KEY (parameter_name, hist_date_insert);


--
-- Name: ref_transformation_parameters pk_ref_transformation_parameters; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_transformation_parameters
    ADD CONSTRAINT pk_ref_transformation_parameters PRIMARY KEY (transformation, parameter_name);


--
-- Name: ref_transformation_parameters_hist pk_ref_transformation_parameters_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_transformation_parameters_hist
    ADD CONSTRAINT pk_ref_transformation_parameters_hist PRIMARY KEY (transformation, parameter_name, hist_date_insert);


--
-- Name: ref_transformations pk_ref_transformations; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_transformations
    ADD CONSTRAINT pk_ref_transformations PRIMARY KEY (transformation);


--
-- Name: ref_transformations_hist pk_ref_transformations_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_transformations_hist
    ADD CONSTRAINT pk_ref_transformations_hist PRIMARY KEY (transformation, hist_date_insert);


--
-- Name: ref_transformations_in_jobs pk_ref_transformations_in_jobs; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_transformations_in_jobs
    ADD CONSTRAINT pk_ref_transformations_in_jobs PRIMARY KEY (job, transformation);


--
-- Name: ref_transformations_in_jobs_hist pk_ref_transformations_in_jobs_hist; Type: CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_transformations_in_jobs_hist
    ADD CONSTRAINT pk_ref_transformations_in_jobs_hist PRIMARY KEY (job, transformation, hist_date_insert);


--
-- Name: fk_inst_run_transformations_runs; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_inst_run_transformations_runs ON inst_run_transformations USING btree (id_run);


--
-- Name: fk_inst_run_transformations_transformations; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_inst_run_transformations_transformations ON inst_run_transformations USING btree (transformation);


--
-- Name: fk_ref_data_vault_link_attributes_id_link; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_data_vault_link_attributes_id_link ON ref_data_vault_link_attributes USING btree (id_data_vault_link);


--
-- Name: fk_ref_data_vault_link_satellites_id_link; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_data_vault_link_satellites_id_link ON ref_data_vault_link_satellites USING btree (id_data_vault_link);


--
-- Name: fk_ref_data_vault_link_satellites_rsrc_id; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_data_vault_link_satellites_rsrc_id ON ref_data_vault_link_satellites USING btree (record_source_id);


--
-- Name: fk_ref_dv_hub_satellites_hubs; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_dv_hub_satellites_hubs ON ref_data_vault_hub_satellites USING btree (id_data_vault_hub);


--
-- Name: fk_ref_dv_hub_satellites_source_tables; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_dv_hub_satellites_source_tables ON ref_data_vault_hub_satellites USING btree (record_source_id);


--
-- Name: fk_ref_dv_hub_sources_source_tables; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_dv_hub_sources_source_tables ON ref_data_vault_hub_sources USING btree (record_source_id);


--
-- Name: fk_ref_dv_link_attributes_links; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_dv_link_attributes_links ON ref_data_vault_link_attributes USING btree (id_data_vault_link);


--
-- Name: fk_ref_dv_link_satellites_source_tables; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_dv_link_satellites_source_tables ON ref_data_vault_link_satellites USING btree (record_source_id);


--
-- Name: fk_ref_dv_link_sources_hist_source_tables; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_dv_link_sources_hist_source_tables ON ref_data_vault_link_sources_hist USING btree (record_source_id);


--
-- Name: fk_ref_dv_link_sources_source_tables; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_dv_link_sources_source_tables ON ref_data_vault_link_sources USING btree (record_source_id);


--
-- Name: fk_ref_dv_links_hub_1; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_dv_links_hub_1 ON ref_data_vault_links USING btree (id_data_vault_hub_1);


--
-- Name: fk_ref_dv_links_hub_10; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_dv_links_hub_10 ON ref_data_vault_links USING btree (id_data_vault_hub_10);


--
-- Name: fk_ref_dv_links_hub_2; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_dv_links_hub_2 ON ref_data_vault_links USING btree (id_data_vault_hub_2);


--
-- Name: fk_ref_dv_links_hub_3; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_dv_links_hub_3 ON ref_data_vault_links USING btree (id_data_vault_hub_3);


--
-- Name: fk_ref_dv_links_hub_4; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_dv_links_hub_4 ON ref_data_vault_links USING btree (id_data_vault_hub_4);


--
-- Name: fk_ref_dv_links_hub_5; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_dv_links_hub_5 ON ref_data_vault_links USING btree (id_data_vault_hub_5);


--
-- Name: fk_ref_dv_links_hub_6; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_dv_links_hub_6 ON ref_data_vault_links USING btree (id_data_vault_hub_6);


--
-- Name: fk_ref_dv_links_hub_7; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_dv_links_hub_7 ON ref_data_vault_links USING btree (id_data_vault_hub_7);


--
-- Name: fk_ref_dv_links_hub_8; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_dv_links_hub_8 ON ref_data_vault_links USING btree (id_data_vault_hub_8);


--
-- Name: fk_ref_dv_links_hub_9; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_dv_links_hub_9 ON ref_data_vault_links USING btree (id_data_vault_hub_9);


--
-- Name: fk_ref_dv_links_satellites_links; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_dv_links_satellites_links ON ref_data_vault_link_satellites USING btree (id_data_vault_link);


--
-- Name: fk_ref_source_file_directories_id_srcsys; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_source_file_directories_id_srcsys ON ref_source_file_directories USING btree (id_srcsys);


--
-- Name: fk_ref_source_files_id_srcfile_directory; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_source_files_id_srcfile_directory ON ref_source_files USING btree (id_srcfile_directory);


--
-- Name: fk_ref_source_systems_source_connection; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_source_systems_source_connection ON ref_source_systems USING btree (id_source_connection);


--
-- Name: fk_ref_source_systems_staging_connection; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX fk_ref_source_systems_staging_connection ON ref_source_systems USING btree (id_staging_connection);


--
-- Name: inst_actual_runs_id_rtyp; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX inst_actual_runs_id_rtyp ON inst_actual_runs USING btree (id_rtyp);


--
-- Name: inst_actual_runs_id_status; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX inst_actual_runs_id_status ON inst_actual_runs USING btree (id_status);


--
-- Name: inst_runs_id_rtyp; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX inst_runs_id_rtyp ON inst_runs USING btree (id_rtyp);


--
-- Name: inst_runs_id_status; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX inst_runs_id_status ON inst_runs USING btree (id_status);


--
-- Name: ref_connections_name; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE UNIQUE INDEX ref_connections_name ON ref_connections USING btree (name);


--
-- Name: ref_data_vault_hubs_id_data_vault; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE UNIQUE INDEX ref_data_vault_hubs_id_data_vault ON ref_data_vault_hubs USING btree (id_data_vault, hub_name);


--
-- Name: ref_data_vault_links_id_data_vault; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE UNIQUE INDEX ref_data_vault_links_id_data_vault ON ref_data_vault_links USING btree (id_data_vault, link_name);


--
-- Name: ref_data_vaults_name; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE UNIQUE INDEX ref_data_vaults_name ON ref_data_vaults USING btree (data_vault_name);


--
-- Name: ref_source_file_directories_id_srcsys; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX ref_source_file_directories_id_srcsys ON ref_source_file_directories USING btree (id_srcsys);


--
-- Name: ref_source_file_directories_srcsys; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX ref_source_file_directories_srcsys ON ref_source_file_directories USING btree (id_srcsys);


--
-- Name: ref_source_files_id_srcfile_directory; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX ref_source_files_id_srcfile_directory ON ref_source_files USING btree (id_srcfile_directory);


--
-- Name: ref_source_tables_srcsys; Type: INDEX; Schema: pdi_meta; Owner: pdi_meta
--

CREATE INDEX ref_source_tables_srcsys ON ref_source_tables USING btree (id_srcsys);


--
-- Name: inst_actual_runs trg_inst_actual_runs_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_inst_actual_runs_after_i AFTER INSERT ON inst_actual_runs FOR EACH ROW EXECUTE PROCEDURE trg_inst_actual_runs_after_i();


--
-- Name: inst_actual_runs trg_inst_actual_runs_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_inst_actual_runs_after_u AFTER UPDATE ON inst_actual_runs FOR EACH ROW EXECUTE PROCEDURE trg_inst_actual_runs_after_u();


--
-- Name: ref_connections trg_ref_connections_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_connections_after_d AFTER DELETE ON ref_connections FOR EACH ROW EXECUTE PROCEDURE trg_ref_connections_after_d();


--
-- Name: ref_connections trg_ref_connections_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_connections_after_i AFTER INSERT ON ref_connections FOR EACH ROW EXECUTE PROCEDURE trg_ref_connections_after_i();


--
-- Name: ref_connections trg_ref_connections_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_connections_after_u AFTER UPDATE ON ref_connections FOR EACH ROW EXECUTE PROCEDURE trg_ref_connections_after_u();


--
-- Name: ref_data_vault_hub_satellite_columns trg_ref_data_vault_hub_satellite_columns_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_hub_satellite_columns_after_d AFTER DELETE ON ref_data_vault_hub_satellite_columns FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_hub_satellite_columns_after_d();


--
-- Name: ref_data_vault_hub_satellite_columns trg_ref_data_vault_hub_satellite_columns_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_hub_satellite_columns_after_i AFTER INSERT ON ref_data_vault_hub_satellite_columns FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_hub_satellite_columns_after_i();


--
-- Name: ref_data_vault_hub_satellite_columns trg_ref_data_vault_hub_satellite_columns_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_hub_satellite_columns_after_u AFTER UPDATE ON ref_data_vault_hub_satellite_columns FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_hub_satellite_columns_after_u();


--
-- Name: ref_data_vault_hub_satellites trg_ref_data_vault_hub_satellites_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_hub_satellites_after_d AFTER DELETE ON ref_data_vault_hub_satellites FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_hub_satellites_after_d();


--
-- Name: ref_data_vault_hub_satellites trg_ref_data_vault_hub_satellites_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_hub_satellites_after_i AFTER INSERT ON ref_data_vault_hub_satellites FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_hub_satellites_after_i();


--
-- Name: ref_data_vault_hub_satellites trg_ref_data_vault_hub_satellites_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_hub_satellites_after_u AFTER UPDATE ON ref_data_vault_hub_satellites FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_hub_satellites_after_u();


--
-- Name: ref_data_vault_hub_sources trg_ref_data_vault_hub_sources_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_hub_sources_after_d AFTER DELETE ON ref_data_vault_hub_sources FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_hub_sources_after_d();


--
-- Name: ref_data_vault_hub_sources trg_ref_data_vault_hub_sources_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_hub_sources_after_i AFTER INSERT ON ref_data_vault_hub_sources FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_hub_sources_after_i();


--
-- Name: ref_data_vault_hub_sources trg_ref_data_vault_hub_sources_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_hub_sources_after_u AFTER UPDATE ON ref_data_vault_hub_sources FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_hub_sources_after_u();


--
-- Name: ref_data_vault_hubs trg_ref_data_vault_hubs_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_hubs_after_d AFTER DELETE ON ref_data_vault_hubs FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_hubs_after_d();


--
-- Name: ref_data_vault_hubs trg_ref_data_vault_hubs_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_hubs_after_i AFTER INSERT ON ref_data_vault_hubs FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_hubs_after_i();


--
-- Name: ref_data_vault_hubs trg_ref_data_vault_hubs_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_hubs_after_u AFTER UPDATE ON ref_data_vault_hubs FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_hubs_after_u();


--
-- Name: ref_data_vault_link_attributes trg_ref_data_vault_link_attributes_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_link_attributes_after_d AFTER DELETE ON ref_data_vault_link_attributes FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_link_attributes_after_d();


--
-- Name: ref_data_vault_link_attributes trg_ref_data_vault_link_attributes_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_link_attributes_after_i AFTER INSERT ON ref_data_vault_link_attributes FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_link_attributes_after_i();


--
-- Name: ref_data_vault_link_attributes trg_ref_data_vault_link_attributes_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_link_attributes_after_u AFTER UPDATE ON ref_data_vault_link_attributes FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_link_attributes_after_u();


--
-- Name: ref_data_vault_link_satellite_columns trg_ref_data_vault_link_satellite_columns_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_link_satellite_columns_after_d AFTER DELETE ON ref_data_vault_link_satellite_columns FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_link_satellite_columns_after_d();


--
-- Name: ref_data_vault_link_satellite_columns trg_ref_data_vault_link_satellite_columns_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_link_satellite_columns_after_i AFTER INSERT ON ref_data_vault_link_satellite_columns FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_link_satellite_columns_after_i();


--
-- Name: ref_data_vault_link_satellite_columns trg_ref_data_vault_link_satellite_columns_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_link_satellite_columns_after_u AFTER UPDATE ON ref_data_vault_link_satellite_columns FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_link_satellite_columns_after_u();


--
-- Name: ref_data_vault_link_satellites trg_ref_data_vault_link_satellites_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_link_satellites_after_d AFTER DELETE ON ref_data_vault_link_satellites FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_link_satellites_after_d();


--
-- Name: ref_data_vault_link_satellites trg_ref_data_vault_link_satellites_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_link_satellites_after_i AFTER INSERT ON ref_data_vault_link_satellites FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_link_satellites_after_i();


--
-- Name: ref_data_vault_link_satellites trg_ref_data_vault_link_satellites_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_link_satellites_after_u AFTER UPDATE ON ref_data_vault_link_satellites FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_link_satellites_after_u();


--
-- Name: ref_data_vault_link_sources trg_ref_data_vault_link_sources_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_link_sources_after_d AFTER DELETE ON ref_data_vault_link_sources FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_link_sources_after_d();


--
-- Name: ref_data_vault_link_sources trg_ref_data_vault_link_sources_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_link_sources_after_i AFTER INSERT ON ref_data_vault_link_sources FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_link_sources_after_i();


--
-- Name: ref_data_vault_link_sources trg_ref_data_vault_link_sources_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_link_sources_after_u AFTER UPDATE ON ref_data_vault_link_sources FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_link_sources_after_u();


--
-- Name: ref_data_vault_links trg_ref_data_vault_links_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_links_after_d AFTER DELETE ON ref_data_vault_links FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_links_after_d();


--
-- Name: ref_data_vault_links trg_ref_data_vault_links_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_links_after_i AFTER INSERT ON ref_data_vault_links FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_links_after_i();


--
-- Name: ref_data_vault_links trg_ref_data_vault_links_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vault_links_after_u AFTER UPDATE ON ref_data_vault_links FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vault_links_after_u();


--
-- Name: ref_data_vaults trg_ref_data_vaults_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vaults_after_d AFTER DELETE ON ref_data_vaults FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vaults_after_d();


--
-- Name: ref_data_vaults trg_ref_data_vaults_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vaults_after_i AFTER INSERT ON ref_data_vaults FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vaults_after_i();


--
-- Name: ref_data_vaults trg_ref_data_vaults_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_data_vaults_after_u AFTER UPDATE ON ref_data_vaults FOR EACH ROW EXECUTE PROCEDURE trg_ref_data_vaults_after_u();


--
-- Name: ref_jobs trg_ref_jobs_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_jobs_after_d AFTER DELETE ON ref_jobs FOR EACH ROW EXECUTE PROCEDURE trg_ref_jobs_after_d();


--
-- Name: ref_jobs trg_ref_jobs_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_jobs_after_i AFTER INSERT ON ref_jobs FOR EACH ROW EXECUTE PROCEDURE trg_ref_jobs_after_i();


--
-- Name: ref_jobs trg_ref_jobs_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_jobs_after_u AFTER UPDATE ON ref_jobs FOR EACH ROW EXECUTE PROCEDURE trg_ref_jobs_after_u();


--
-- Name: ref_jobs_in_jobs trg_ref_jobs_in_jobs_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_jobs_in_jobs_after_d AFTER DELETE ON ref_jobs_in_jobs FOR EACH ROW EXECUTE PROCEDURE trg_ref_jobs_in_jobs_after_d();


--
-- Name: ref_jobs_in_jobs trg_ref_jobs_in_jobs_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_jobs_in_jobs_after_i AFTER INSERT ON ref_jobs_in_jobs FOR EACH ROW EXECUTE PROCEDURE trg_ref_jobs_in_jobs_after_i();


--
-- Name: ref_jobs_in_jobs trg_ref_jobs_in_jobs_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_jobs_in_jobs_after_u AFTER UPDATE ON ref_jobs_in_jobs FOR EACH ROW EXECUTE PROCEDURE trg_ref_jobs_in_jobs_after_u();


--
-- Name: ref_processing_stages trg_ref_processing_stages_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_processing_stages_after_d AFTER DELETE ON ref_processing_stages FOR EACH ROW EXECUTE PROCEDURE trg_ref_processing_stages_after_d();


--
-- Name: ref_processing_stages trg_ref_processing_stages_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_processing_stages_after_i AFTER INSERT ON ref_processing_stages FOR EACH ROW EXECUTE PROCEDURE trg_ref_processing_stages_after_i();


--
-- Name: ref_processing_stages trg_ref_processing_stages_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_processing_stages_after_u AFTER UPDATE ON ref_processing_stages FOR EACH ROW EXECUTE PROCEDURE trg_ref_processing_stages_after_u();


--
-- Name: ref_runtypes trg_ref_runtypes_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_runtypes_after_d AFTER DELETE ON ref_runtypes FOR EACH ROW EXECUTE PROCEDURE trg_ref_runtypes_after_d();


--
-- Name: ref_runtypes trg_ref_runtypes_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_runtypes_after_i AFTER INSERT ON ref_runtypes FOR EACH ROW EXECUTE PROCEDURE trg_ref_runtypes_after_i();


--
-- Name: ref_runtypes trg_ref_runtypes_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_runtypes_after_u AFTER UPDATE ON ref_runtypes FOR EACH ROW EXECUTE PROCEDURE trg_ref_runtypes_after_u();


--
-- Name: ref_source_file_columns trg_ref_source_file_columns_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_source_file_columns_after_d AFTER DELETE ON ref_source_file_columns FOR EACH ROW EXECUTE PROCEDURE trg_ref_source_file_columns_after_d();


--
-- Name: ref_source_file_columns trg_ref_source_file_columns_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_source_file_columns_after_i AFTER INSERT ON ref_source_file_columns FOR EACH ROW EXECUTE PROCEDURE trg_ref_source_file_columns_after_i();


--
-- Name: ref_source_file_columns trg_ref_source_file_columns_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_source_file_columns_after_u AFTER UPDATE ON ref_source_file_columns FOR EACH ROW EXECUTE PROCEDURE trg_ref_source_file_columns_after_u();


--
-- Name: ref_source_file_directories trg_ref_source_file_directories_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_source_file_directories_after_d AFTER DELETE ON ref_source_file_directories FOR EACH ROW EXECUTE PROCEDURE trg_ref_source_file_directories_after_d();


--
-- Name: ref_source_file_directories trg_ref_source_file_directories_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_source_file_directories_after_i AFTER INSERT ON ref_source_file_directories FOR EACH ROW EXECUTE PROCEDURE trg_ref_source_file_directories_after_i();


--
-- Name: ref_source_file_directories trg_ref_source_file_directories_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_source_file_directories_after_u AFTER UPDATE ON ref_source_file_directories FOR EACH ROW EXECUTE PROCEDURE trg_ref_source_file_directories_after_u();


--
-- Name: ref_source_files trg_ref_source_files_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_source_files_after_d AFTER DELETE ON ref_source_files FOR EACH ROW EXECUTE PROCEDURE trg_ref_source_files_after_d();


--
-- Name: ref_source_files trg_ref_source_files_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_source_files_after_i AFTER INSERT ON ref_source_files FOR EACH ROW EXECUTE PROCEDURE trg_ref_source_files_after_i();


--
-- Name: ref_source_files trg_ref_source_files_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_source_files_after_u AFTER UPDATE ON ref_source_files FOR EACH ROW EXECUTE PROCEDURE trg_ref_source_files_after_u();


--
-- Name: ref_source_systems trg_ref_source_systems_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_source_systems_after_d AFTER DELETE ON ref_source_systems FOR EACH ROW EXECUTE PROCEDURE trg_ref_source_systems_after_d();


--
-- Name: ref_source_systems trg_ref_source_systems_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_source_systems_after_i AFTER INSERT ON ref_source_systems FOR EACH ROW EXECUTE PROCEDURE trg_ref_source_systems_after_i();


--
-- Name: ref_source_systems trg_ref_source_systems_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_source_systems_after_u AFTER UPDATE ON ref_source_systems FOR EACH ROW EXECUTE PROCEDURE trg_ref_source_systems_after_u();


--
-- Name: ref_source_tables trg_ref_source_tables_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_source_tables_after_d AFTER DELETE ON ref_source_tables FOR EACH ROW EXECUTE PROCEDURE trg_ref_source_tables_after_d();


--
-- Name: ref_source_tables trg_ref_source_tables_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_source_tables_after_i AFTER INSERT ON ref_source_tables FOR EACH ROW EXECUTE PROCEDURE trg_ref_source_tables_after_i();


--
-- Name: ref_source_tables trg_ref_source_tables_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_source_tables_after_u AFTER UPDATE ON ref_source_tables FOR EACH ROW EXECUTE PROCEDURE trg_ref_source_tables_after_u();


--
-- Name: ref_source_tables_staging_load_from_overrule trg_ref_source_tables_staging_load_from_overrule_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_source_tables_staging_load_from_overrule_after_d AFTER DELETE ON ref_source_tables_staging_load_from_overrule FOR EACH ROW EXECUTE PROCEDURE trg_ref_source_tables_staging_load_from_overrule_after_d();


--
-- Name: ref_source_tables_staging_load_from_overrule trg_ref_source_tables_staging_load_from_overrule_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_source_tables_staging_load_from_overrule_after_i AFTER INSERT ON ref_source_tables_staging_load_from_overrule FOR EACH ROW EXECUTE PROCEDURE trg_ref_source_tables_staging_load_from_overrule_after_i();


--
-- Name: ref_source_tables_staging_load_from_overrule trg_ref_source_tables_staging_load_from_overrule_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_source_tables_staging_load_from_overrule_after_u AFTER UPDATE ON ref_source_tables_staging_load_from_overrule FOR EACH ROW EXECUTE PROCEDURE trg_ref_source_tables_staging_load_from_overrule_after_u();


--
-- Name: ref_statuses trg_ref_statuses_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_statuses_after_d AFTER DELETE ON ref_statuses FOR EACH ROW EXECUTE PROCEDURE trg_ref_statuses_after_d();


--
-- Name: ref_statuses trg_ref_statuses_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_statuses_after_i AFTER INSERT ON ref_statuses FOR EACH ROW EXECUTE PROCEDURE trg_ref_statuses_after_i();


--
-- Name: ref_statuses trg_ref_statuses_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_statuses_after_u AFTER UPDATE ON ref_statuses FOR EACH ROW EXECUTE PROCEDURE trg_ref_statuses_after_u();


--
-- Name: ref_system_parameters trg_ref_system_parameters_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_system_parameters_after_d AFTER DELETE ON ref_system_parameters FOR EACH ROW EXECUTE PROCEDURE trg_ref_system_parameters_after_d();


--
-- Name: ref_system_parameters trg_ref_system_parameters_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_system_parameters_after_i AFTER INSERT ON ref_system_parameters FOR EACH ROW EXECUTE PROCEDURE trg_ref_system_parameters_after_i();


--
-- Name: ref_system_parameters trg_ref_system_parameters_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_system_parameters_after_u AFTER UPDATE ON ref_system_parameters FOR EACH ROW EXECUTE PROCEDURE trg_ref_system_parameters_after_u();


--
-- Name: ref_transformation_parameters trg_ref_transformation_parameters_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_transformation_parameters_after_d AFTER DELETE ON ref_transformation_parameters FOR EACH ROW EXECUTE PROCEDURE trg_ref_transformation_parameters_after_d();


--
-- Name: ref_transformation_parameters trg_ref_transformation_parameters_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_transformation_parameters_after_i AFTER INSERT ON ref_transformation_parameters FOR EACH ROW EXECUTE PROCEDURE trg_ref_transformation_parameters_after_i();


--
-- Name: ref_transformation_parameters trg_ref_transformation_parameters_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_transformation_parameters_after_u AFTER UPDATE ON ref_transformation_parameters FOR EACH ROW EXECUTE PROCEDURE trg_ref_transformation_parameters_after_u();


--
-- Name: ref_transformations trg_ref_transformations_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_transformations_after_d AFTER DELETE ON ref_transformations FOR EACH ROW EXECUTE PROCEDURE trg_ref_transformations_after_d();


--
-- Name: ref_transformations trg_ref_transformations_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_transformations_after_i AFTER INSERT ON ref_transformations FOR EACH ROW EXECUTE PROCEDURE trg_ref_transformations_after_i();


--
-- Name: ref_transformations trg_ref_transformations_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_transformations_after_u AFTER UPDATE ON ref_transformations FOR EACH ROW EXECUTE PROCEDURE trg_ref_transformations_after_u();


--
-- Name: ref_transformations_in_jobs trg_ref_transformations_in_jobs_after_d; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_transformations_in_jobs_after_d AFTER DELETE ON ref_transformations_in_jobs FOR EACH ROW EXECUTE PROCEDURE trg_ref_transformations_in_jobs_after_d();


--
-- Name: ref_transformations_in_jobs trg_ref_transformations_in_jobs_after_i; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_transformations_in_jobs_after_i AFTER INSERT ON ref_transformations_in_jobs FOR EACH ROW EXECUTE PROCEDURE trg_ref_transformations_in_jobs_after_i();


--
-- Name: ref_transformations_in_jobs trg_ref_transformations_in_jobs_after_u; Type: TRIGGER; Schema: pdi_meta; Owner: pdi_meta
--

CREATE TRIGGER trg_ref_transformations_in_jobs_after_u AFTER UPDATE ON ref_transformations_in_jobs FOR EACH ROW EXECUTE PROCEDURE trg_ref_transformations_in_jobs_after_u();


--
-- Name: inst_actual_runs fk_inst_actual_runs_rtyp; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY inst_actual_runs
    ADD CONSTRAINT fk_inst_actual_runs_rtyp FOREIGN KEY (id_rtyp) REFERENCES ref_runtypes(id_rtyp);


--
-- Name: inst_actual_runs fk_inst_actual_runs_status; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY inst_actual_runs
    ADD CONSTRAINT fk_inst_actual_runs_status FOREIGN KEY (id_status) REFERENCES ref_statuses(id_status);


--
-- Name: inst_run_transformations fk_inst_run_transformations_runs; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY inst_run_transformations
    ADD CONSTRAINT fk_inst_run_transformations_runs FOREIGN KEY (id_run) REFERENCES inst_runs(id_run);


--
-- Name: inst_runs fk_inst_runs_rtyp; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY inst_runs
    ADD CONSTRAINT fk_inst_runs_rtyp FOREIGN KEY (id_rtyp) REFERENCES ref_runtypes(id_rtyp);


--
-- Name: inst_runs fk_inst_runs_status; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY inst_runs
    ADD CONSTRAINT fk_inst_runs_status FOREIGN KEY (id_status) REFERENCES ref_statuses(id_status);


--
-- Name: ref_data_vault_hub_satellite_columns fk_ref_dv_hub_satellite_columns_sat; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_hub_satellite_columns
    ADD CONSTRAINT fk_ref_dv_hub_satellite_columns_sat FOREIGN KEY (id_data_vault_hub_sat) REFERENCES ref_data_vault_hub_satellites(id_data_vault_hub_sat);


--
-- Name: ref_data_vault_hub_satellites fk_ref_dv_hub_satellites_hubs; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_hub_satellites
    ADD CONSTRAINT fk_ref_dv_hub_satellites_hubs FOREIGN KEY (id_data_vault_hub) REFERENCES ref_data_vault_hubs(id_data_vault_hub);


--
-- Name: ref_data_vault_hub_satellites fk_ref_dv_hub_satellites_source_tables; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_hub_satellites
    ADD CONSTRAINT fk_ref_dv_hub_satellites_source_tables FOREIGN KEY (record_source_id) REFERENCES ref_source_tables(id_srctab);


--
-- Name: ref_data_vault_hub_sources fk_ref_dv_hub_sources_hubs; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_hub_sources
    ADD CONSTRAINT fk_ref_dv_hub_sources_hubs FOREIGN KEY (id_data_vault_hub) REFERENCES ref_data_vault_hubs(id_data_vault_hub);


--
-- Name: ref_data_vault_hub_sources fk_ref_dv_hub_sources_source_tables; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_hub_sources
    ADD CONSTRAINT fk_ref_dv_hub_sources_source_tables FOREIGN KEY (record_source_id) REFERENCES ref_source_tables(id_srctab);


--
-- Name: ref_data_vault_link_attributes fk_ref_dv_link_attributes_links; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_link_attributes
    ADD CONSTRAINT fk_ref_dv_link_attributes_links FOREIGN KEY (id_data_vault_link) REFERENCES ref_data_vault_links(id_data_vault_link);


--
-- Name: ref_data_vault_link_satellite_columns fk_ref_dv_link_satellite_columns_sat; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_link_satellite_columns
    ADD CONSTRAINT fk_ref_dv_link_satellite_columns_sat FOREIGN KEY (id_data_vault_link_sat) REFERENCES ref_data_vault_link_satellites(id_data_vault_link_sat);


--
-- Name: ref_data_vault_link_satellites fk_ref_dv_link_satellites_source_tables; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_link_satellites
    ADD CONSTRAINT fk_ref_dv_link_satellites_source_tables FOREIGN KEY (record_source_id) REFERENCES ref_source_tables(id_srctab);


--
-- Name: ref_data_vault_link_sources fk_ref_dv_link_sources_source_links; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_link_sources
    ADD CONSTRAINT fk_ref_dv_link_sources_source_links FOREIGN KEY (id_data_vault_link) REFERENCES ref_data_vault_links(id_data_vault_link);


--
-- Name: ref_data_vault_link_sources fk_ref_dv_link_sources_source_tables; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_link_sources
    ADD CONSTRAINT fk_ref_dv_link_sources_source_tables FOREIGN KEY (record_source_id) REFERENCES ref_source_tables(id_srctab);


--
-- Name: ref_data_vault_links fk_ref_dv_links_hub_1; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_links
    ADD CONSTRAINT fk_ref_dv_links_hub_1 FOREIGN KEY (id_data_vault_hub_1) REFERENCES ref_data_vault_hubs(id_data_vault_hub);


--
-- Name: ref_data_vault_links fk_ref_dv_links_hub_10; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_links
    ADD CONSTRAINT fk_ref_dv_links_hub_10 FOREIGN KEY (id_data_vault_hub_10) REFERENCES ref_data_vault_hubs(id_data_vault_hub);


--
-- Name: ref_data_vault_links fk_ref_dv_links_hub_2; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_links
    ADD CONSTRAINT fk_ref_dv_links_hub_2 FOREIGN KEY (id_data_vault_hub_2) REFERENCES ref_data_vault_hubs(id_data_vault_hub);


--
-- Name: ref_data_vault_links fk_ref_dv_links_hub_3; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_links
    ADD CONSTRAINT fk_ref_dv_links_hub_3 FOREIGN KEY (id_data_vault_hub_3) REFERENCES ref_data_vault_hubs(id_data_vault_hub);


--
-- Name: ref_data_vault_links fk_ref_dv_links_hub_4; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_links
    ADD CONSTRAINT fk_ref_dv_links_hub_4 FOREIGN KEY (id_data_vault_hub_4) REFERENCES ref_data_vault_hubs(id_data_vault_hub);


--
-- Name: ref_data_vault_links fk_ref_dv_links_hub_5; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_links
    ADD CONSTRAINT fk_ref_dv_links_hub_5 FOREIGN KEY (id_data_vault_hub_5) REFERENCES ref_data_vault_hubs(id_data_vault_hub);


--
-- Name: ref_data_vault_links fk_ref_dv_links_hub_6; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_links
    ADD CONSTRAINT fk_ref_dv_links_hub_6 FOREIGN KEY (id_data_vault_hub_6) REFERENCES ref_data_vault_hubs(id_data_vault_hub);


--
-- Name: ref_data_vault_links fk_ref_dv_links_hub_7; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_links
    ADD CONSTRAINT fk_ref_dv_links_hub_7 FOREIGN KEY (id_data_vault_hub_7) REFERENCES ref_data_vault_hubs(id_data_vault_hub);


--
-- Name: ref_data_vault_links fk_ref_dv_links_hub_8; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_links
    ADD CONSTRAINT fk_ref_dv_links_hub_8 FOREIGN KEY (id_data_vault_hub_8) REFERENCES ref_data_vault_hubs(id_data_vault_hub);


--
-- Name: ref_data_vault_links fk_ref_dv_links_hub_9; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_links
    ADD CONSTRAINT fk_ref_dv_links_hub_9 FOREIGN KEY (id_data_vault_hub_9) REFERENCES ref_data_vault_hubs(id_data_vault_hub);


--
-- Name: ref_data_vault_link_satellites fk_ref_dv_links_satellites_links; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_data_vault_link_satellites
    ADD CONSTRAINT fk_ref_dv_links_satellites_links FOREIGN KEY (id_data_vault_link) REFERENCES ref_data_vault_links(id_data_vault_link);


--
-- Name: ref_source_systems fk_ref_source_system_source_connection; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_source_systems
    ADD CONSTRAINT fk_ref_source_system_source_connection FOREIGN KEY (id_source_connection) REFERENCES ref_connections(id_connection);


--
-- Name: ref_source_systems fk_ref_source_system_staging_connection; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_source_systems
    ADD CONSTRAINT fk_ref_source_system_staging_connection FOREIGN KEY (id_staging_connection) REFERENCES ref_connections(id_connection);


--
-- Name: inst_run_parameters inst_run_parameters_ibfk_1; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY inst_run_parameters
    ADD CONSTRAINT inst_run_parameters_ibfk_1 FOREIGN KEY (id_run) REFERENCES inst_runs(id_run);


--
-- Name: ref_source_file_columns ref_source_file_columns_ibfk_1; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_source_file_columns
    ADD CONSTRAINT ref_source_file_columns_ibfk_1 FOREIGN KEY (id_srcfile) REFERENCES ref_source_files(id_srcfile);


--
-- Name: ref_source_file_directories ref_source_file_directories_srcsys; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_source_file_directories
    ADD CONSTRAINT ref_source_file_directories_srcsys FOREIGN KEY (id_srcsys) REFERENCES ref_source_systems(id_srcsys);


--
-- Name: ref_source_files ref_source_files_ibfk_1; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_source_files
    ADD CONSTRAINT ref_source_files_ibfk_1 FOREIGN KEY (id_srcfile_directory) REFERENCES ref_source_file_directories(id_srcfile_directory);


--
-- Name: ref_source_tables ref_source_tables_srcsys; Type: FK CONSTRAINT; Schema: pdi_meta; Owner: pdi_meta
--

ALTER TABLE ONLY ref_source_tables
    ADD CONSTRAINT ref_source_tables_srcsys FOREIGN KEY (id_srcsys) REFERENCES ref_source_systems(id_srcsys);


--
-- Switch to data_vault schema for data_vault-specific objects
--

SET ROLE data_vault;
SET search_path TO data_vault, public;

--
-- Name: prc_create_error_table(character varying, character varying); Type: FUNCTION; Schema: data_vault; Owner: data_vault
--

CREATE FUNCTION data_vault.prc_create_error_table(p_table_name character varying, p_schema_name character varying) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE recordvar        RECORD;
DECLARE stmt_def         TEXT;
BEGIN

stmt_def := concat('create table if not exists ',p_schema_name,'.',p_table_name,'_err (');

FOR recordvar IN select concat(case when ordinal_position = 1 then '' else ',' end , column_name , ' '
,      case
          when column_name = 'load_dts'         then ' TIMESTAMP'
          when column_name = 'last_seen_dts'    then ' TIMESTAMP '
          when column_name = 'record_source_id' then ' INT'
          when ordinal_position  = 1            then ' TEXT DEFAULT -1'
          else                                       ' TEXT'
       end)
       as attribute
from   information_schema.columns
where  table_name   = p_table_name
and    table_schema = p_schema_name
order  by ordinal_position
LOOP
       stmt_def := concat(stmt_def,recordvar.attribute);
END LOOP;

stmt_def := concat(stmt_def,',etl_err_date timestamp default now(),etl_id_run int,etl_err_noe int, etl_err_desc varchar(512),etl_err_col varchar(256),etl_err_cod varchar(256) )');

EXECUTE stmt_def;

END;
$$;


ALTER FUNCTION data_vault.prc_create_error_table(p_table_name character varying, p_schema_name character varying) OWNER TO data_vault;

--
-- Name: vw_information_schema_columns_data_vault; Type: VIEW; Schema: data_vault; Owner: data_vault
--

CREATE OR REPLACE VIEW data_vault.vw_information_schema_columns_data_vault AS
 SELECT columns.table_name,
    columns.table_schema,
    columns.column_name,
    columns.ordinal_position,
    columns.is_nullable,
    columns.data_type
   FROM information_schema.columns
  WHERE columns.table_schema::text = 'data_vault'::text;


ALTER VIEW data_vault.vw_information_schema_columns_data_vault OWNER TO data_vault;

--
-- Name: gen_lnk_qry_no_as(text); Type: FUNCTION; Schema: data_vault; Owner: data_vault
--

CREATE FUNCTION data_vault.gen_lnk_qry_no_as(f1 text, OUT text) RETURNS text
    LANGUAGE sql
    AS $$
select case when f1 <> '''-1''' AND f1 IS NOT NULL then concat(',',concat(f1)) else '' end
$$;


ALTER FUNCTION data_vault.gen_lnk_qry_no_as(f1 text, OUT text) OWNER TO data_vault;

--
-- Name: gen_lnk_qry_w_as(text, text); Type: FUNCTION; Schema: data_vault; Owner: data_vault
--

CREATE FUNCTION data_vault.gen_lnk_qry_w_as(f1 text, f2 text, OUT text) RETURNS text
    LANGUAGE sql
    AS $$
select case when f1 <> '''-1''' AND f1 IS NOT NULL then concat(',',concat(f1,' as ',f2)) else '' end
$$;


ALTER FUNCTION data_vault.gen_lnk_qry_w_as(f1 text, f2 text, OUT text) OWNER TO data_vault;

--
-- Name: ms_dv_cl_wrp_typ1(text); Type: FUNCTION; Schema: data_vault; Owner: data_vault
--

CREATE FUNCTION data_vault.ms_dv_cl_wrp_typ1(f1 text, OUT text) RETURNS text
    LANGUAGE sql
    AS $_$
 select case when $1  is not null then concat('||''${CDC_DEL}''||coalesce(cast(',$1 ,' as text),''','${CDC_NULL}',''')') else '' end

$_$;


ALTER FUNCTION data_vault.ms_dv_cl_wrp_typ1(f1 text, OUT text) OWNER TO data_vault;

--
-- Name: ms_dv_cl_wrp_typ2(text, text); Type: FUNCTION; Schema: data_vault; Owner: data_vault
--

CREATE FUNCTION data_vault.ms_dv_cl_wrp_typ2(f1 text, f2 text, OUT text) RETURNS text
    LANGUAGE sql
    AS $$
 select case when f1 is not null then concat(',',concat(f1,' as ',f2)) else '' end

$$;


ALTER FUNCTION data_vault.ms_dv_cl_wrp_typ2(f1 text, f2 text, OUT text) OWNER TO data_vault;


RESET ROLE;
SET ROLE staging;
SET search_path TO staging, public;

--
-- Name: gen_lnk_qry_no_as(text); Type: FUNCTION; Schema: staging; Owner: staging
--

CREATE FUNCTION staging.gen_lnk_qry_no_as(f1 text, OUT text) RETURNS text
    LANGUAGE sql
    AS $$
select case when f1 <> '-1' AND f1 IS NOT NULL then concat(',',concat(f1)) else '' end
$$;


ALTER FUNCTION staging.gen_lnk_qry_no_as(f1 text, OUT text) OWNER TO staging;

--
-- Name: gen_lnk_qry_w_as(text, text); Type: FUNCTION; Schema: staging; Owner: staging
--

CREATE FUNCTION staging.gen_lnk_qry_w_as(f1 text, f2 text, OUT text) RETURNS text
    LANGUAGE sql
    AS $$
select case when f1 <> '-1' AND f1 IS NOT NULL then concat(',',concat(f1,' as ',f2)) else '' end
$$;


ALTER FUNCTION staging.gen_lnk_qry_w_as(f1 text, f2 text, OUT text) OWNER TO staging;

--
-- Restore pdi_meta search path
--

RESET ROLE;
SET search_path = pdi_meta, pg_catalog;

--
-- PostgreSQL database dump complete
--
