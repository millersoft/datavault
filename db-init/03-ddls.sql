\connect datavault

SET ROLE staging;
set search_path to staging, pg_catalog;

--
-- Name: stg_sak_actor; Type: TABLE; Schema: staging; Owner: staging
--

CREATE TABLE staging.stg_sak_actor (
    actor_id integer NOT NULL,
    first_name character varying(45) NOT NULL,
    last_name character varying(50),
    last_update timestamp without time zone,
    hash_actor_id bytea,
    tenant_id character varying(20) DEFAULT 'SAKILA'::character varying,

    CONSTRAINT chk_stg_sak_actor_hash_actor_id_len
        CHECK (hash_actor_id IS NULL OR octet_length(hash_actor_id) = 32)
);

ALTER TABLE staging.stg_sak_actor OWNER TO staging;

--
-- Name: stg_sak_customer; Type: TABLE; Schema: staging; Owner: staging
--

CREATE TABLE staging.stg_sak_customer (
    customer_id integer NOT NULL,
    store_id integer NOT NULL,
    first_name character varying(45) NOT NULL,
    last_name character varying(45) NOT NULL,
    email character varying(50),
    address_id integer NOT NULL,
    active integer,
    create_date timestamp without time zone NOT NULL,
    last_update timestamp without time zone,
    hash_customer_id bytea,
    hash_store_id bytea,
    hash_address_id bytea,
    tenant_id character varying(20) DEFAULT 'SAKILA'::character varying,

    CONSTRAINT chk_stg_sak_customer_hash_customer_id_len
        CHECK (hash_customer_id IS NULL OR octet_length(hash_customer_id) = 32),

    CONSTRAINT chk_stg_sak_customer_hash_store_id_len
        CHECK (hash_store_id IS NULL OR octet_length(hash_store_id) = 32),

    CONSTRAINT chk_stg_sak_customer_hash_address_id_len
        CHECK (hash_address_id IS NULL OR octet_length(hash_address_id) = 32)
);


ALTER TABLE staging.stg_sak_customer OWNER TO staging;

--
-- Name: stg_sak_film; Type: TABLE; Schema: staging; Owner: staging
--

CREATE TABLE staging.stg_sak_film (
    film_id integer NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    release_year character varying(6),
    language_id integer NOT NULL,
    original_language_id integer,
    rental_duration integer,
    rental_rate numeric(4,2) NOT NULL,
    length integer,
    replacement_cost numeric(5,2) NOT NULL,
    rating character varying(10),
    special_features character varying(100),
    last_update timestamp without time zone,
    hash_film_id bytea,
    hash_language_id bytea,
    tenant_id character varying(20) DEFAULT 'SAKILA'::character varying,

    CONSTRAINT chk_stg_sak_film_hash_film_id_len
        CHECK (hash_film_id IS NULL OR octet_length(hash_film_id) = 32),

    CONSTRAINT chk_stg_sak_film_hash_language_id_len
        CHECK (hash_language_id IS NULL OR octet_length(hash_language_id) = 32)
);

ALTER TABLE staging.stg_sak_film OWNER TO staging;

--
-- Name: stg_sak_film_actor; Type: TABLE; Schema: staging; Owner: staging
--

CREATE TABLE staging.stg_sak_film_actor (
    actor_id integer NOT NULL,
    film_id integer NOT NULL,
    last_update timestamp without time zone,
    hash_actor_id bytea,
    hash_film_id bytea,
    tenant_id character varying(20) DEFAULT 'SAKILA'::character varying,

    CONSTRAINT chk_stg_sak_film_actor_hash_actor_id_len
        CHECK (hash_actor_id IS NULL OR octet_length(hash_actor_id) = 32),

    CONSTRAINT chk_stg_sak_film_actor_hash_film_id_len
        CHECK (hash_film_id IS NULL OR octet_length(hash_film_id) = 32)
);

ALTER TABLE staging.stg_sak_film_actor OWNER TO staging;

--
-- Name: stg_sak_inventory; Type: TABLE; Schema: staging; Owner: staging
--

CREATE TABLE staging.stg_sak_inventory (
    hash_inventory_id bytea,
    hash_film_id bytea,
    hash_store_id bytea,
    inventory_id integer NOT NULL,
    film_id integer NOT NULL,
    store_id integer NOT NULL,
    last_update timestamp without time zone,
    tenant_id character varying(20) DEFAULT 'SAKILA'::character varying,

    CONSTRAINT chk_stg_sak_inventory_hash_inventory_id_len
        CHECK (hash_inventory_id IS NULL OR octet_length(hash_inventory_id) = 32),

    CONSTRAINT chk_stg_sak_inventory_hash_film_id_len
        CHECK (hash_film_id IS NULL OR octet_length(hash_film_id) = 32),

    CONSTRAINT chk_stg_sak_inventory_hash_store_id_len
        CHECK (hash_store_id IS NULL OR octet_length(hash_store_id) = 32)
);

ALTER TABLE staging.stg_sak_inventory OWNER TO staging;

--
-- Name: stg_sak_staff; Type: TABLE; Schema: staging; Owner: staging
--

CREATE TABLE staging.stg_sak_staff (
    staff_id integer NOT NULL,
    first_name character varying(45) NOT NULL,
    last_name character varying(45) NOT NULL,
    address_id integer NOT NULL,
    picture bytea,
    email character varying(50),
    store_id integer NOT NULL,
    active integer,
    username character varying(16) NOT NULL,
    password character varying(40),
    last_update timestamp without time zone,
    hash_staff_id bytea,
    hash_address_id bytea,
    hash_store_id bytea,
    tenant_id character varying(20) DEFAULT 'SAKILA'::character varying,

    CONSTRAINT chk_stg_sak_staff_hash_staff_id_len
        CHECK (hash_staff_id IS NULL OR octet_length(hash_staff_id) = 32),

    CONSTRAINT chk_stg_sak_staff_hash_address_id_len
        CHECK (hash_address_id IS NULL OR octet_length(hash_address_id) = 32),

    CONSTRAINT chk_stg_sak_staff_hash_store_id_len
        CHECK (hash_store_id IS NULL OR octet_length(hash_store_id) = 32)
);


ALTER TABLE staging.stg_sak_staff OWNER TO staging;

--
-- Name: stg_sak_store; Type: TABLE; Schema: staging; Owner: staging
--

CREATE TABLE staging.stg_sak_store (
    hash_store_id bytea,
    hash_manager_staff_id bytea,
    hash_address_id bytea,
    store_id integer NOT NULL,
    manager_staff_id integer NOT NULL,
    address_id integer NOT NULL,
    last_update timestamp without time zone,
    tenant_id character varying(20) DEFAULT 'SAKILA'::character varying,

    CONSTRAINT chk_stg_sak_store_hash_store_id_len
        CHECK (hash_store_id IS NULL OR octet_length(hash_store_id) = 32),

    CONSTRAINT chk_stg_sak_store_hash_manager_staff_id_len
        CHECK (hash_manager_staff_id IS NULL OR octet_length(hash_manager_staff_id) = 32),

    CONSTRAINT chk_stg_sak_store_hash_address_id_len
        CHECK (hash_address_id IS NULL OR octet_length(hash_address_id) = 32)
);

ALTER TABLE staging.stg_sak_store OWNER TO staging;

--
-- Name: vw_stg_sak_actor; Type: VIEW; Schema: staging; Owner: staging
--

CREATE VIEW staging.vw_stg_sak_actor AS
 SELECT stg_sak_actor.actor_id,
    stg_sak_actor.first_name,
    stg_sak_actor.last_name,
    stg_sak_actor.last_update,
    stg_sak_actor.hash_actor_id
   FROM staging.stg_sak_actor;


ALTER TABLE staging.vw_stg_sak_actor OWNER TO staging;

--
-- Name: stg_sak_actor stg_sak_actor_pkey; Type: CONSTRAINT; Schema: staging; Owner: staging
--

ALTER TABLE ONLY staging.stg_sak_actor
    ADD CONSTRAINT stg_sak_actor_pkey PRIMARY KEY (actor_id);


--
-- Name: stg_sak_customer stg_sak_customer_pkey; Type: CONSTRAINT; Schema: staging; Owner: staging
--

ALTER TABLE ONLY staging.stg_sak_customer
    ADD CONSTRAINT stg_sak_customer_pkey PRIMARY KEY (customer_id);


--
-- Name: stg_sak_film_actor stg_sak_film_actor_pkey; Type: CONSTRAINT; Schema: staging; Owner: staging
--

ALTER TABLE ONLY staging.stg_sak_film_actor
    ADD CONSTRAINT stg_sak_film_actor_pkey PRIMARY KEY (actor_id, film_id);


--
-- Name: stg_sak_film stg_sak_film_pkey; Type: CONSTRAINT; Schema: staging; Owner: staging
--

ALTER TABLE ONLY staging.stg_sak_film
    ADD CONSTRAINT stg_sak_film_pkey PRIMARY KEY (film_id);


--
-- Name: stg_sak_inventory stg_sak_inventory_pkey; Type: CONSTRAINT; Schema: staging; Owner: staging
--

ALTER TABLE ONLY staging.stg_sak_inventory
    ADD CONSTRAINT stg_sak_inventory_pkey PRIMARY KEY (inventory_id);


--
-- Name: stg_sak_staff stg_sak_staff_pkey; Type: CONSTRAINT; Schema: staging; Owner: staging
--

ALTER TABLE ONLY staging.stg_sak_staff
    ADD CONSTRAINT stg_sak_staff_pkey PRIMARY KEY (staff_id);


--
-- Name: stg_sak_store stg_sak_store_pkey; Type: CONSTRAINT; Schema: staging; Owner: staging
--

ALTER TABLE ONLY staging.stg_sak_store
    ADD CONSTRAINT stg_sak_store_pkey PRIMARY KEY (store_id);


GRANT ALL ON SCHEMA staging TO staging;
GRANT ALL ON SCHEMA staging TO pdi_meta;

--
-- PostgreSQL database dump complete
--


RESET ROLE;
SET ROLE data_vault;
set search_path to data_vault, pg_catalog;

--
-- Name: hub_actor; Type: TABLE; Schema: data_vault; Owner: pdi_meta
--

CREATE TABLE data_vault.hub_actor (
    hub_actor_id bytea NOT NULL,
    actor_id character varying(32),
    load_dts timestamp(6) without time zone,
    record_source_id integer,
    last_seen_dts timestamp(6) without time zone,
    tenant_id character varying(20),

    CONSTRAINT chk_hub_actor_hub_actor_id_len
        CHECK (octet_length(hub_actor_id) = 32)
);

ALTER TABLE data_vault.hub_actor OWNER TO data_vault;

--
-- Name: hub_actor_err; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.hub_actor_err (
    hub_actor_id text DEFAULT '-1'::integer,
    actor_id text,
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,
    tenant_id text,
    etl_err_date timestamp without time zone DEFAULT now(),
    etl_id_run integer,
    etl_err_noe integer,
    etl_err_desc character varying(512),
    etl_err_col character varying(256),
    etl_err_cod character varying(256)
);


ALTER TABLE data_vault.hub_actor_err OWNER TO data_vault;



--
-- Name: hub_actor_test; Type: VIEW; Schema: data_vault; Owner: data_vault
--

CREATE VIEW data_vault.hub_actor_test AS
 SELECT hub_actor.hub_actor_id,
    hub_actor.actor_id,
    hub_actor.load_dts,
    hub_actor.record_source_id,
    hub_actor.last_seen_dts,
    hub_actor.tenant_id
   FROM data_vault.hub_actor;


ALTER TABLE data_vault.hub_actor_test OWNER TO data_vault;

--
-- Name: hub_address; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.hub_address (
    hub_address_id bytea NOT NULL,
    address_id character varying(32),
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,
    tenant_id character varying(20),

    CONSTRAINT chk_hub_address_hub_address_id_len
        CHECK (octet_length(hub_address_id) = 32)
);


ALTER TABLE data_vault.hub_address OWNER TO data_vault;



--
-- Name: hub_category; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.hub_category (
    hub_category_id bytea NOT NULL,
    category_id character varying(32),
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,

    CONSTRAINT chk_hub_category_hub_category_id_len
        CHECK (octet_length(hub_category_id) = 32)
);


ALTER TABLE data_vault.hub_category OWNER TO data_vault;



--
-- Name: hub_city; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.hub_city (
    hub_city_id bytea NOT NULL,
    city_id character varying(32),
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,

    CONSTRAINT chk_hub_city_hub_city_id_len
        CHECK (octet_length(hub_city_id) = 32)
);


ALTER TABLE data_vault.hub_city OWNER TO data_vault;



--
-- Name: hub_country; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.hub_country (
    hub_country_id bytea NOT NULL,
    country_id character varying(32),
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,

    CONSTRAINT chk_hub_country_hub_country_id_len
        CHECK (octet_length(hub_country_id) = 32)
);


ALTER TABLE data_vault.hub_country OWNER TO data_vault;



--
-- Name: hub_customer; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.hub_customer (
    hub_customer_id bytea NOT NULL,
    customer_id character varying(32),
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,
    tenant_id character varying(20),

    CONSTRAINT chk_hub_customer_hub_customer_id_len
        CHECK (octet_length(hub_customer_id) = 32)
);


ALTER TABLE data_vault.hub_customer OWNER TO data_vault;

--
-- Name: hub_customer_err; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.hub_customer_err (
    hub_customer_id text DEFAULT '-1'::integer,
    customer_id text,
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,
    tenant_id text,
    etl_err_date timestamp without time zone DEFAULT now(),
    etl_id_run integer,
    etl_err_noe integer,
    etl_err_desc character varying(512),
    etl_err_col character varying(256),
    etl_err_cod character varying(256)
);


ALTER TABLE data_vault.hub_customer_err OWNER TO data_vault;



--
-- Name: hub_film; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.hub_film (
    hub_film_id bytea NOT NULL,
    film_id character varying(32),
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,
    tenant_id character varying(20),

    CONSTRAINT chk_hub_film_hub_film_id_len
        CHECK (octet_length(hub_film_id) = 32)
);

ALTER TABLE data_vault.hub_film OWNER TO data_vault;

--
-- Name: hub_film_err; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.hub_film_err (
    hub_film_id text DEFAULT '-1'::integer,
    film_id text,
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,
    tenant_id text,
    etl_err_date timestamp without time zone DEFAULT now(),
    etl_id_run integer,
    etl_err_noe integer,
    etl_err_desc character varying(512),
    etl_err_col character varying(256),
    etl_err_cod character varying(256)
);


ALTER TABLE data_vault.hub_film_err OWNER TO data_vault;



--
-- Name: hub_film_run; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.hub_film_run (
    hub_film_id bytea,
    load_dts timestamp without time zone,
    tenant_id character varying(20),
    record_source_id integer,

    CONSTRAINT chk_hub_film_run_hub_film_id_len
        CHECK (hub_film_id IS NULL OR octet_length(hub_film_id) = 32)
);


ALTER TABLE data_vault.hub_film_run OWNER TO data_vault;

--
-- Name: hub_inventory; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.hub_inventory (
    hub_inventory_id bytea NOT NULL,
    inventory_id character varying(32),
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,
    tenant_id character varying(20),

    CONSTRAINT chk_hub_inventory_hub_inventory_id_len
        CHECK (octet_length(hub_inventory_id) = 32)
);

ALTER TABLE data_vault.hub_inventory OWNER TO data_vault;

--
-- Name: hub_inventory_err; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.hub_inventory_err (
    hub_inventory_id text DEFAULT '-1'::integer,
    inventory_id text,
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,
    tenant_id text,
    etl_err_date timestamp without time zone DEFAULT now(),
    etl_id_run integer,
    etl_err_noe integer,
    etl_err_desc character varying(512),
    etl_err_col character varying(256),
    etl_err_cod character varying(256)
);


ALTER TABLE data_vault.hub_inventory_err OWNER TO data_vault;



--
-- Name: hub_language; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.hub_language (
    hub_language_id bytea NOT NULL,
    language_id character varying(32),
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,

    CONSTRAINT chk_hub_language_hub_language_id_len
        CHECK (octet_length(hub_language_id) = 32)
);


ALTER TABLE data_vault.hub_language OWNER TO data_vault;



--
-- Name: hub_payment; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.hub_payment (
    hub_payment_id bytea NOT NULL,
    payment_id character varying(32),
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,

    CONSTRAINT chk_hub_payment_hub_payment_id_len
        CHECK (octet_length(hub_payment_id) = 32)
);


ALTER TABLE data_vault.hub_payment OWNER TO data_vault;



--
-- Name: hub_rental; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.hub_rental (
    hub_rental_id bytea NOT NULL,
    rental_id character varying(32),
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,

    CONSTRAINT chk_hub_rental_hub_rental_id_len
        CHECK (octet_length(hub_rental_id) = 32)
);


ALTER TABLE data_vault.hub_rental OWNER TO data_vault;



--
-- Name: hub_staff; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.hub_staff (
    hub_staff_id bytea NOT NULL,
    staff_id character varying(32),
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,
    tenant_id character varying(20),

    CONSTRAINT chk_hub_staff_hub_staff_id_len
        CHECK (octet_length(hub_staff_id) = 32)
);


ALTER TABLE data_vault.hub_staff OWNER TO data_vault;

--
-- Name: hub_staff_err; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.hub_staff_err (
    hub_staff_id text DEFAULT '-1'::integer,
    staff_id text,
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,
    tenant_id text,
    etl_err_date timestamp without time zone DEFAULT now(),
    etl_id_run integer,
    etl_err_noe integer,
    etl_err_desc character varying(512),
    etl_err_col character varying(256),
    etl_err_cod character varying(256)
);


ALTER TABLE data_vault.hub_staff_err OWNER TO data_vault;



--
-- Name: hub_store; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.hub_store (
    hub_store_id bytea NOT NULL,
    store_id character varying(32),
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,
    tenant_id character varying(20),

    CONSTRAINT chk_hub_store_hub_store_id_len
        CHECK (octet_length(hub_store_id) = 32)
);

ALTER TABLE data_vault.hub_store OWNER TO data_vault;

--
-- Name: hub_store_err; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.hub_store_err (
    hub_store_id text DEFAULT '-1'::integer,
    store_id text,
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,
    tenant_id text,
    etl_err_date timestamp without time zone DEFAULT now(),
    etl_id_run integer,
    etl_err_noe integer,
    etl_err_desc character varying(512),
    etl_err_col character varying(256),
    etl_err_cod character varying(256)
);


ALTER TABLE data_vault.hub_store_err OWNER TO data_vault;



--
-- Name: link_address_city; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_address_city (
    link_address_city_id bytea NOT NULL,
    hub_address_id bytea NOT NULL,
    hub_city_id bytea NOT NULL,
    load_dts timestamp without time zone,
    record_source_id integer,

    CONSTRAINT chk_link_address_city_link_address_city_id_len
        CHECK (octet_length(link_address_city_id) = 32),

    CONSTRAINT chk_link_address_city_hub_address_id_len
        CHECK (octet_length(hub_address_id) = 32),

    CONSTRAINT chk_link_address_city_hub_city_id_len
        CHECK (octet_length(hub_city_id) = 32)
);


ALTER TABLE data_vault.link_address_city OWNER TO data_vault;



--
-- Name: link_city_country; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_city_country (
    link_city_country_id bytea NOT NULL,
    hub_city_id bytea NOT NULL,
    hub_country_id bytea NOT NULL,
    load_dts timestamp without time zone,
    record_source_id integer,

    CONSTRAINT chk_link_city_country_link_city_country_id_len
        CHECK (octet_length(link_city_country_id) = 32),

    CONSTRAINT chk_link_city_country_hub_city_id_len
        CHECK (octet_length(hub_city_id) = 32),

    CONSTRAINT chk_link_city_country_hub_country_id_len
        CHECK (octet_length(hub_country_id) = 32)
);


ALTER TABLE data_vault.link_city_country OWNER TO data_vault;



--
-- Name: link_customer_address; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_customer_address (
    link_customer_address_id bytea NOT NULL,
    hub_customer_id bytea NOT NULL,
    hub_address_id bytea NOT NULL,
    load_dts timestamp without time zone,
    record_source_id integer,

    CONSTRAINT chk_link_customer_address_link_customer_address_id_len
        CHECK (octet_length(link_customer_address_id) = 32),

    CONSTRAINT chk_link_customer_address_hub_customer_id_len
        CHECK (octet_length(hub_customer_id) = 32),

    CONSTRAINT chk_link_customer_address_hub_address_id_len
        CHECK (octet_length(hub_address_id) = 32)
);


ALTER TABLE data_vault.link_customer_address OWNER TO data_vault;



--
-- Name: link_customer_store; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_customer_store (
    link_customer_store_id bytea NOT NULL,
    hub_customer_id bytea NOT NULL,
    hub_store_id bytea NOT NULL,
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,
    tenant_id character varying(20) NOT NULL,

    CONSTRAINT chk_link_customer_store_link_customer_store_id_len
        CHECK (octet_length(link_customer_store_id) = 32),

    CONSTRAINT chk_link_customer_store_hub_customer_id_len
        CHECK (octet_length(hub_customer_id) = 32),

    CONSTRAINT chk_link_customer_store_hub_store_id_len
        CHECK (octet_length(hub_store_id) = 32)
);


ALTER TABLE data_vault.link_customer_store OWNER TO data_vault;

--
-- Name: link_customer_store_err; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_customer_store_err (
    link_customer_store_id text DEFAULT '-1'::integer,
    hub_customer_id text,
    hub_store_id text,
    load_dts timestamp without time zone,
    record_source_id integer,
    last_seen_dts timestamp without time zone,
    tenant_id text,
    etl_err_date timestamp without time zone DEFAULT now(),
    etl_id_run integer,
    etl_err_noe integer,
    etl_err_desc character varying(512),
    etl_err_col character varying(256),
    etl_err_cod character varying(256)
);


ALTER TABLE data_vault.link_customer_store_err OWNER TO data_vault;



--
-- Name: link_film_actor; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_film_actor (
    link_film_actor_id bytea NOT NULL,
    hub_film_id bytea NOT NULL,
    hub_actor_id bytea NOT NULL,
    load_dts timestamp without time zone,
    record_source_id integer,
    tenant_id character varying(20) NOT NULL,

    CONSTRAINT chk_link_film_actor_id_len
        CHECK (octet_length(link_film_actor_id) = 32),

    CONSTRAINT chk_link_film_actor_hub_film_id_len
        CHECK (octet_length(hub_film_id) = 32),

    CONSTRAINT chk_link_film_actor_hub_actor_id_len
        CHECK (octet_length(hub_actor_id) = 32)
);

ALTER TABLE data_vault.link_film_actor OWNER TO data_vault;

--
-- Name: link_film_actor_err; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_film_actor_err (
    link_film_actor_id text DEFAULT '-1'::integer,
    hub_film_id text,
    hub_actor_id text,
    load_dts timestamp without time zone,
    record_source_id integer,
    tenant_id text,
    etl_err_date timestamp without time zone DEFAULT now(),
    etl_id_run integer,
    etl_err_noe integer,
    etl_err_desc character varying(512),
    etl_err_col character varying(256),
    etl_err_cod character varying(256)
);


ALTER TABLE data_vault.link_film_actor_err OWNER TO data_vault;



--
-- Name: link_film_actor_run; Type: TABLE; Schema: data_vault; Owner: data_vault
--

CREATE TABLE data_vault.link_film_actor_run (
    link_film_actor_id bytea,
    hub_film_id bytea,
    hub_actor_id bytea,
    load_dts timestamp without time zone,
    record_source_id integer,
    tenant_id character varying(20),

    CONSTRAINT chk_link_film_actor_run_link_film_actor_id_len
        CHECK (link_film_actor_id IS NULL OR octet_length(link_film_actor_id) = 32),

    CONSTRAINT chk_link_film_actor_run_hub_film_id_len
        CHECK (hub_film_id IS NULL OR octet_length(hub_film_id) = 32),

    CONSTRAINT chk_link_film_actor_run_hub_actor_id_len
        CHECK (hub_actor_id IS NULL OR octet_length(hub_actor_id) = 32)
);


ALTER TABLE data_vault.link_film_actor_run OWNER TO data_vault;

--
-- Name: link_film_category; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_film_category (
    link_film_category_id bytea NOT NULL,
    hub_film_id bytea NOT NULL,
    hub_category_id bytea NOT NULL,
    load_dts timestamp without time zone,
    record_source_id integer,

    CONSTRAINT chk_link_film_category_link_film_category_id_len
        CHECK (octet_length(link_film_category_id) = 32),

    CONSTRAINT chk_link_film_category_hub_film_id_len
        CHECK (octet_length(hub_film_id) = 32),

    CONSTRAINT chk_link_film_category_hub_category_id_len
        CHECK (octet_length(hub_category_id) = 32)
);


ALTER TABLE data_vault.link_film_category OWNER TO data_vault;



--
-- Name: link_film_head_actor; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_film_head_actor (
    link_film_head_actor_id bytea NOT NULL,
    hub_film_id bytea NOT NULL,
    hub_actor_id bytea NOT NULL,
    load_dts timestamp without time zone,
    record_source_id integer,

    CONSTRAINT chk_link_film_head_actor_link_film_head_actor_id_len
        CHECK (octet_length(link_film_head_actor_id) = 32),

    CONSTRAINT chk_link_film_head_actor_hub_film_id_len
        CHECK (octet_length(hub_film_id) = 32),

    CONSTRAINT chk_link_film_head_actor_hub_actor_id_len
        CHECK (octet_length(hub_actor_id) = 32)
);


ALTER TABLE data_vault.link_film_head_actor OWNER TO data_vault;



--
-- Name: link_film_head_actor_run; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_film_head_actor_run (
    link_film_head_actor_id bytea,
    hub_film_id bytea,
    hub_actor_id bytea,
    load_dts timestamp without time zone,
    record_source_id integer,

    CONSTRAINT chk_link_film_head_actor_run_link_film_head_actor_id_len
        CHECK (link_film_head_actor_id IS NULL OR octet_length(link_film_head_actor_id) = 32),

    CONSTRAINT chk_link_film_head_actor_run_hub_film_id_len
        CHECK (hub_film_id IS NULL OR octet_length(hub_film_id) = 32),

    CONSTRAINT chk_link_film_head_actor_run_hub_actor_id_len
        CHECK (hub_actor_id IS NULL OR octet_length(hub_actor_id) = 32)
);


ALTER TABLE data_vault.link_film_head_actor_run OWNER TO data_vault;

--
-- Name: link_film_language; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_film_language (
    link_film_language_id bytea NOT NULL,
    hub_film_id bytea NOT NULL,
    hub_language_id bytea NOT NULL,
    hub_language_id_original bytea NOT NULL,
    load_dts timestamp without time zone,
    record_source_id integer,

    CONSTRAINT chk_link_film_language_link_film_language_id_len
        CHECK (octet_length(link_film_language_id) = 32),

    CONSTRAINT chk_link_film_language_hub_film_id_len
        CHECK (octet_length(hub_film_id) = 32),

    CONSTRAINT chk_link_film_language_hub_language_id_len
        CHECK (octet_length(hub_language_id) = 32),

    CONSTRAINT chk_link_film_language_hub_language_id_original_len
        CHECK (octet_length(hub_language_id_original) = 32)
);


ALTER TABLE data_vault.link_film_language OWNER TO data_vault;



--
-- Name: link_inventory; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_inventory (
    link_inventory_id bytea NOT NULL,
    hub_inventory_id bytea NOT NULL,
    hub_film_id bytea NOT NULL,
    hub_store_id bytea NOT NULL,
    load_dts timestamp without time zone,
    record_source_id integer,
    film_id integer,
    lnk_attributes_concat_dv bytea,
    tenant_id character varying(20) NOT NULL,

    CONSTRAINT chk_link_inventory_link_inventory_id_len
        CHECK (octet_length(link_inventory_id) = 32),

    CONSTRAINT chk_link_inventory_hub_inventory_id_len
        CHECK (octet_length(hub_inventory_id) = 32),

    CONSTRAINT chk_link_inventory_hub_film_id_len
        CHECK (octet_length(hub_film_id) = 32),

    CONSTRAINT chk_link_inventory_hub_store_id_len
        CHECK (octet_length(hub_store_id) = 32),

    CONSTRAINT chk_link_inventory_lnk_attributes_concat_dv_len
        CHECK (lnk_attributes_concat_dv IS NULL OR octet_length(lnk_attributes_concat_dv) = 32)
);

ALTER TABLE data_vault.link_inventory OWNER TO data_vault;

--
-- Name: link_inventory_err; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_inventory_err (
    link_inventory_id text DEFAULT '-1'::integer,
    hub_inventory_id text,
    hub_film_id text,
    hub_store_id text,
    load_dts timestamp without time zone,
    record_source_id integer,
    film_id text,
    lnk_attributes_concat_dv text,
    tenant_id text,
    etl_err_date timestamp without time zone DEFAULT now(),
    etl_id_run integer,
    etl_err_noe integer,
    etl_err_desc character varying(512),
    etl_err_col character varying(256),
    etl_err_cod character varying(256)
);


ALTER TABLE data_vault.link_inventory_err OWNER TO data_vault;



--
-- Name: link_payment; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_payment (
    link_payment_id bytea NOT NULL,
    hub_payment_id bytea NOT NULL,
    hub_customer_id bytea NOT NULL,
    hub_staff_id bytea NOT NULL,
    load_dts timestamp without time zone,
    record_source_id integer,

    CONSTRAINT chk_link_payment_link_payment_id_len
        CHECK (octet_length(link_payment_id) = 32),

    CONSTRAINT chk_link_payment_hub_payment_id_len
        CHECK (octet_length(hub_payment_id) = 32),

    CONSTRAINT chk_link_payment_hub_customer_id_len
        CHECK (octet_length(hub_customer_id) = 32),

    CONSTRAINT chk_link_payment_hub_staff_id_len
        CHECK (octet_length(hub_staff_id) = 32)
);


ALTER TABLE data_vault.link_payment OWNER TO data_vault;



--
-- Name: link_payment_rental; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_payment_rental (
    link_payment_rental_id bytea NOT NULL,
    hub_payment_id bytea NOT NULL,
    hub_rental_id bytea NOT NULL,
    load_dts timestamp without time zone,
    record_source_id integer,

    CONSTRAINT chk_link_payment_rental_link_payment_rental_id_len
        CHECK (octet_length(link_payment_rental_id) = 32),

    CONSTRAINT chk_link_payment_rental_hub_payment_id_len
        CHECK (octet_length(hub_payment_id) = 32),

    CONSTRAINT chk_link_payment_rental_hub_rental_id_len
        CHECK (octet_length(hub_rental_id) = 32)
);


ALTER TABLE data_vault.link_payment_rental OWNER TO data_vault;



--
-- Name: link_rental; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_rental (
    link_rental_id bytea NOT NULL,
    hub_rental_id bytea NOT NULL,
    hub_customer_id bytea NOT NULL,
    hub_staff_id bytea NOT NULL,
    hub_inventory_id bytea NOT NULL,
    load_dts timestamp without time zone,
    record_source_id integer,

    CONSTRAINT chk_link_rental_link_rental_id_len
        CHECK (octet_length(link_rental_id) = 32),

    CONSTRAINT chk_link_rental_hub_rental_id_len
        CHECK (octet_length(hub_rental_id) = 32),

    CONSTRAINT chk_link_rental_hub_customer_id_len
        CHECK (octet_length(hub_customer_id) = 32),

    CONSTRAINT chk_link_rental_hub_staff_id_len
        CHECK (octet_length(hub_staff_id) = 32),

    CONSTRAINT chk_link_rental_hub_inventory_id_len
        CHECK (octet_length(hub_inventory_id) = 32)
);


ALTER TABLE data_vault.link_rental OWNER TO data_vault;



--
-- Name: link_staff_address; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_staff_address (
    link_staff_address_id bytea NOT NULL,
    hub_staff_id bytea NOT NULL,
    hub_address_id bytea NOT NULL,
    load_dts timestamp without time zone,
    record_source_id integer,

    CONSTRAINT chk_link_staff_address_link_staff_address_id_len
        CHECK (octet_length(link_staff_address_id) = 32),

    CONSTRAINT chk_link_staff_address_hub_staff_id_len
        CHECK (octet_length(hub_staff_id) = 32),

    CONSTRAINT chk_link_staff_address_hub_address_id_len
        CHECK (octet_length(hub_address_id) = 32)
);


ALTER TABLE data_vault.link_staff_address OWNER TO data_vault;



--
-- Name: link_staff_worksin_store; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_staff_worksin_store (
    link_staff_worksin_store_id bytea NOT NULL,
    hub_staff_id bytea NOT NULL,
    hub_store_id bytea NOT NULL,
    load_dts timestamp without time zone,
    record_source_id integer,
    tenant_id character varying(20) NOT NULL,

    CONSTRAINT chk_link_staff_worksin_store_link_staff_worksin_store_id_len
        CHECK (octet_length(link_staff_worksin_store_id) = 32),

    CONSTRAINT chk_link_staff_worksin_store_hub_staff_id_len
        CHECK (octet_length(hub_staff_id) = 32),

    CONSTRAINT chk_link_staff_worksin_store_hub_store_id_len
        CHECK (octet_length(hub_store_id) = 32)
);


ALTER TABLE data_vault.link_staff_worksin_store OWNER TO data_vault;

--
-- Name: link_staff_worksin_store_err; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_staff_worksin_store_err (
    link_staff_worksin_store_id text DEFAULT '-1'::integer,
    hub_staff_id text,
    hub_store_id text,
    load_dts timestamp without time zone,
    record_source_id integer,
    tenant_id text,
    etl_err_date timestamp without time zone DEFAULT now(),
    etl_id_run integer,
    etl_err_noe integer,
    etl_err_desc character varying(512),
    etl_err_col character varying(256),
    etl_err_cod character varying(256)
);


ALTER TABLE data_vault.link_staff_worksin_store_err OWNER TO data_vault;



--
-- Name: link_store_address; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_store_address (
    link_store_address_id bytea NOT NULL,
    hub_store_id bytea NOT NULL,
    hub_address_id bytea NOT NULL,
    load_dts timestamp without time zone,
    record_source_id integer,

    CONSTRAINT chk_link_store_address_link_store_address_id_len
        CHECK (octet_length(link_store_address_id) = 32),

    CONSTRAINT chk_link_store_address_hub_store_id_len
        CHECK (octet_length(hub_store_id) = 32),

    CONSTRAINT chk_link_store_address_hub_address_id_len
        CHECK (octet_length(hub_address_id) = 32)
);


ALTER TABLE data_vault.link_store_address OWNER TO data_vault;



--
-- Name: link_store_manager; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.link_store_manager (
    link_store_manager_id bytea NOT NULL,
    hub_store_id bytea NOT NULL,
    hub_staff_id bytea NOT NULL,
    load_dts timestamp without time zone,
    record_source_id integer,

    CONSTRAINT chk_link_store_manager_link_store_manager_id_len
        CHECK (octet_length(link_store_manager_id) = 32),

    CONSTRAINT chk_link_store_manager_hub_store_id_len
        CHECK (octet_length(hub_store_id) = 32),

    CONSTRAINT chk_link_store_manager_hub_staff_id_len
        CHECK (octet_length(hub_staff_id) = 32)
);


ALTER TABLE data_vault.link_store_manager OWNER TO data_vault;



--
-- Name: sat_actor; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_actor (
    sat_key bytea NOT NULL,
    hub_actor_id bytea NOT NULL,
    load_dts timestamp without time zone,
    load_end_dts timestamp without time zone,
    record_source_id integer,
    first_name character varying(45),
    last_name character varying(45),
    last_update timestamp without time zone,
    sat_attributes_concat bytea,
    tenant_id character varying(20) NOT NULL,

    CONSTRAINT chk_sat_actor_sat_key_len
        CHECK (octet_length(sat_key) = 32),

    CONSTRAINT chk_sat_actor_hub_actor_id_len
        CHECK (octet_length(hub_actor_id) = 32),

    CONSTRAINT chk_sat_actor_sat_attributes_concat_len
        CHECK (sat_attributes_concat IS NULL OR octet_length(sat_attributes_concat) = 32)
);

ALTER TABLE data_vault.sat_actor OWNER TO data_vault;

--
-- Name: sat_actor_err; Type: TABLE; Schema: data_vault; Owner: data_vault
--

CREATE TABLE data_vault.sat_actor_err (
    sat_key text DEFAULT '-1'::integer,
    hub_actor_id text,
    load_dts timestamp without time zone,
    load_end_dts text,
    record_source_id integer,
    first_name text,
    last_name text,
    last_update text,
    sat_attributes_concat text,
    tenant_id text,
    etl_err_date timestamp without time zone DEFAULT now(),
    etl_id_run integer,
    etl_err_noe integer,
    etl_err_desc character varying(512),
    etl_err_col character varying(256),
    etl_err_cod character varying(256)
);


ALTER TABLE data_vault.sat_actor_err OWNER TO data_vault;

--
-- Name: sat_address; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_address (
    sat_key bytea NOT NULL,
    hub_address_id bytea NOT NULL,
    load_dts timestamp without time zone,
    load_end_dts timestamp without time zone,
    record_source_id integer,
    address character varying(50),
    address2 character varying(50),
    district character varying(20),
    postal_code character varying(10),
    phone character varying(20),
    last_update timestamp without time zone,
    sat_attributes_concat bytea,

    CONSTRAINT chk_sat_address_sat_key_len
        CHECK (octet_length(sat_key) = 32),

    CONSTRAINT chk_sat_address_hub_address_id_len
        CHECK (octet_length(hub_address_id) = 32),

    CONSTRAINT chk_sat_address_sat_attributes_concat_len
        CHECK (sat_attributes_concat IS NULL OR octet_length(sat_attributes_concat) = 32)
);


ALTER TABLE data_vault.sat_address OWNER TO data_vault;



--
-- Name: sat_category; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_category (
    sat_key bytea NOT NULL,
    hub_category_id bytea NOT NULL,
    load_dts timestamp without time zone,
    load_end_dts timestamp without time zone,
    record_source_id integer,
    name character varying(50),
    last_update timestamp without time zone,
    sat_attributes_concat bytea,

    CONSTRAINT chk_sat_category_sat_key_len
        CHECK (octet_length(sat_key) = 32),

    CONSTRAINT chk_sat_category_hub_category_id_len
        CHECK (octet_length(hub_category_id) = 32),

    CONSTRAINT chk_sat_category_sat_attributes_concat_len
        CHECK (sat_attributes_concat IS NULL OR octet_length(sat_attributes_concat) = 32)
);


ALTER TABLE data_vault.sat_category OWNER TO data_vault;



--
-- Name: sat_city; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_city (
    sat_key bytea NOT NULL,
    hub_city_id bytea NOT NULL,
    load_dts timestamp without time zone,
    load_end_dts timestamp without time zone,
    record_source_id integer,
    city character varying(50),
    last_update timestamp without time zone,
    sat_attributes_concat bytea,

    CONSTRAINT chk_sat_city_sat_key_len
        CHECK (octet_length(sat_key) = 32),

    CONSTRAINT chk_sat_city_hub_city_id_len
        CHECK (octet_length(hub_city_id) = 32),

    CONSTRAINT chk_sat_city_sat_attributes_concat_len
        CHECK (sat_attributes_concat IS NULL OR octet_length(sat_attributes_concat) = 32)
);


ALTER TABLE data_vault.sat_city OWNER TO data_vault;



--
-- Name: sat_country; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_country (
    sat_key bytea NOT NULL,
    hub_country_id bytea NOT NULL,
    load_dts timestamp without time zone,
    load_end_dts timestamp without time zone,
    record_source_id integer,
    country character varying(50),
    last_update timestamp without time zone,
    sat_attributes_concat bytea,

    CONSTRAINT chk_sat_country_sat_key_len
        CHECK (octet_length(sat_key) = 32),

    CONSTRAINT chk_sat_country_hub_country_id_len
        CHECK (octet_length(hub_country_id) = 32),

    CONSTRAINT chk_sat_country_sat_attributes_concat_len
        CHECK (sat_attributes_concat IS NULL OR octet_length(sat_attributes_concat) = 32)
);


ALTER TABLE data_vault.sat_country OWNER TO data_vault;



--
-- Name: sat_customer; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_customer (
    sat_key bytea NOT NULL,
    hub_customer_id bytea NOT NULL,
    load_dts timestamp without time zone,
    load_end_dts timestamp without time zone,
    record_source_id integer,
    first_name character varying(45),
    last_name character varying(45),
    email character varying(50),
    active integer,
    last_update timestamp without time zone,
    create_date timestamp without time zone,
    sat_attributes_concat bytea,
    tenant_id character varying(20) NOT NULL,

    CONSTRAINT chk_sat_customer_sat_key_len
        CHECK (octet_length(sat_key) = 32),

    CONSTRAINT chk_sat_customer_hub_customer_id_len
        CHECK (octet_length(hub_customer_id) = 32),

    CONSTRAINT chk_sat_customer_sat_attributes_concat_len
        CHECK (sat_attributes_concat IS NULL OR octet_length(sat_attributes_concat) = 32)
);


ALTER TABLE data_vault.sat_customer OWNER TO data_vault;

--
-- Name: sat_customer_err; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_customer_err (
    sat_key text DEFAULT '-1'::integer,
    hub_customer_id text,
    load_dts timestamp without time zone,
    load_end_dts text,
    record_source_id integer,
    first_name text,
    last_name text,
    email text,
    active text,
    last_update text,
    create_date text,
    sat_attributes_concat text,
    tenant_id text,
    etl_err_date timestamp without time zone DEFAULT now(),
    etl_id_run integer,
    etl_err_noe integer,
    etl_err_desc character varying(512),
    etl_err_col character varying(256),
    etl_err_cod character varying(256)
);


ALTER TABLE data_vault.sat_customer_err OWNER TO data_vault;


--
-- Name: sat_film; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_film (
    sat_key bytea NOT NULL,
    hub_film_id bytea NOT NULL,
    load_dts timestamp without time zone,
    load_end_dts timestamp without time zone,
    record_source_id integer,
    title character varying(255),
    description text,
    release_year character varying(8),
    rental_duration integer,
    rental_rate numeric(5,2),
    length integer,
    replacement_cost numeric(5,2),
    rating character varying(10),
    special_features character varying(100),
    last_update timestamp without time zone,
    sat_attributes_concat bytea,
    tenant_id character varying(20) NOT NULL,

    CONSTRAINT chk_sat_film_sat_key_len
        CHECK (octet_length(sat_key) = 32),

    CONSTRAINT chk_sat_film_hub_film_id_len
        CHECK (octet_length(hub_film_id) = 32),

    CONSTRAINT chk_sat_film_sat_attributes_concat_len
        CHECK (sat_attributes_concat IS NULL OR octet_length(sat_attributes_concat) = 32)
);

ALTER TABLE data_vault.sat_film OWNER TO data_vault;

--
-- Name: sat_film_err; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_film_err (
    sat_key text DEFAULT '-1'::integer,
    hub_film_id text,
    load_dts timestamp without time zone,
    load_end_dts text,
    record_source_id integer,
    title text,
    description text,
    release_year text,
    rental_duration text,
    rental_rate text,
    length text,
    replacement_cost text,
    rating text,
    special_features text,
    last_update text,
    sat_attributes_concat text,
    tenant_id text,
    etl_err_date timestamp without time zone DEFAULT now(),
    etl_id_run integer,
    etl_err_noe integer,
    etl_err_desc character varying(512),
    etl_err_col character varying(256),
    etl_err_cod character varying(256)
);


ALTER TABLE data_vault.sat_film_err OWNER TO data_vault;

--
-- Name: sat_hub_film_status; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_hub_film_status (
    hub_film_id bytea NOT NULL,
    operation character(1),
    ind_deleted integer NOT NULL,
    load_dts timestamp without time zone NOT NULL,
    load_end_dts timestamp without time zone,
    tenant_id character varying(20) NOT NULL,
    record_source_id integer NOT NULL,

    CONSTRAINT chk_sat_hub_film_status_hub_film_id_len
        CHECK (octet_length(hub_film_id) = 32)
);


ALTER TABLE data_vault.sat_hub_film_status OWNER TO data_vault;

--
-- Name: sat_hub_film_surrogate_keys; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_hub_film_surrogate_keys (
    sat_key bytea NOT NULL,
    hub_film_id bytea NOT NULL,
    id_srcsys integer NOT NULL,
    source_surrogate_key character varying(20),
    load_dts timestamp(6) without time zone,
    load_end_dts timestamp(6) without time zone,
    record_source_id integer,
    tenant_id character varying(20),

    CONSTRAINT chk_sat_hub_film_surrogate_keys_sat_key_len
        CHECK (octet_length(sat_key) = 32),

    CONSTRAINT chk_sat_hub_film_surrogate_keys_hub_film_id_len
        CHECK (octet_length(hub_film_id) = 32)
);


ALTER TABLE data_vault.sat_hub_film_surrogate_keys OWNER TO data_vault;

--
-- Name: sat_hub_film_surrogate_keys_err; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_hub_film_surrogate_keys_err (
    sat_key text DEFAULT '-1'::integer,
    hub_film_id text,
    id_srcsys text,
    source_surrogate_key text,
    load_dts timestamp without time zone,
    load_end_dts text,
    record_source_id integer,
    tenant_id text,
    etl_err_date timestamp without time zone DEFAULT now(),
    etl_id_run integer,
    etl_err_noe integer,
    etl_err_desc character varying(512),
    etl_err_col character varying(256),
    etl_err_cod character varying(256)
);


ALTER TABLE data_vault.sat_hub_film_surrogate_keys_err OWNER TO data_vault;



--
-- Name: sat_language; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_language (
    sat_key bytea NOT NULL,
    hub_language_id bytea NOT NULL,
    load_dts timestamp without time zone,
    load_end_dts timestamp without time zone,
    record_source_id integer,
    name character varying(50),
    last_update timestamp without time zone,
    sat_attributes_concat bytea,

    CONSTRAINT chk_sat_language_sat_key_len
        CHECK (octet_length(sat_key) = 32),

    CONSTRAINT chk_sat_language_hub_language_id_len
        CHECK (octet_length(hub_language_id) = 32),

    CONSTRAINT chk_sat_language_sat_attributes_concat_len
        CHECK (sat_attributes_concat IS NULL OR octet_length(sat_attributes_concat) = 32)
);


ALTER TABLE data_vault.sat_language OWNER TO data_vault;



--
-- Name: sat_link_film_actor_status; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_link_film_actor_status (
    link_film_actor_id bytea NOT NULL,
    operation character(1),
    ind_deleted integer NOT NULL,
    load_dts timestamp without time zone NOT NULL,
    load_end_dts timestamp without time zone,
    record_source_id integer NOT NULL,
    tenant_id character varying(20),

    CONSTRAINT chk_sat_link_film_actor_status_link_film_actor_id_len
        CHECK (octet_length(link_film_actor_id) = 32)
);


ALTER TABLE data_vault.sat_link_film_actor_status OWNER TO data_vault;

--
-- Name: sat_link_film_actor_valid; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_link_film_actor_valid (
    sat_link_film_actor_valid_id integer NOT NULL,
    link_film_actor_id bytea,
    load_dts timestamp without time zone,
    record_source_id integer,
    load_end_dts timestamp without time zone,
    ind_valid integer,

    CONSTRAINT chk_sat_link_film_actor_valid_link_film_actor_id_len
        CHECK (link_film_actor_id IS NULL OR octet_length(link_film_actor_id) = 32)
);


ALTER TABLE data_vault.sat_link_film_actor_valid OWNER TO data_vault;

--
-- Name: sat_link_film_actor_valid_sat_link_film_actor_valid_id_seq; Type: SEQUENCE; Schema: data_vault; Owner: postgres
--

CREATE SEQUENCE data_vault.sat_link_film_actor_valid_sat_link_film_actor_valid_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE data_vault.sat_link_film_actor_valid_sat_link_film_actor_valid_id_seq OWNER TO data_vault;

--
-- Name: sat_link_film_actor_valid_sat_link_film_actor_valid_id_seq; Type: SEQUENCE OWNED BY; Schema: data_vault; Owner: postgres
--

ALTER SEQUENCE data_vault.sat_link_film_actor_valid_sat_link_film_actor_valid_id_seq OWNED BY data_vault.sat_link_film_actor_valid.sat_link_film_actor_valid_id;


--
-- Name: sat_link_film_head_actor_valid; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_link_film_head_actor_valid (
    sat_link_film_head_actor_valid_id integer NOT NULL,
    link_film_head_actor_id bytea,
    load_dts timestamp without time zone,
    record_source_id integer,
    load_end_dts timestamp without time zone,
    ind_valid integer,

    CONSTRAINT chk_sat_link_film_head_actor_valid_link_film_head_actor_id_len
        CHECK (link_film_head_actor_id IS NULL OR octet_length(link_film_head_actor_id) = 32)
);


ALTER TABLE data_vault.sat_link_film_head_actor_valid OWNER TO data_vault;

--
-- Name: sat_link_film_head_actor_vali_sat_link_film_head_actor_vali_seq; Type: SEQUENCE; Schema: data_vault; Owner: postgres
--

CREATE SEQUENCE data_vault.sat_link_film_head_actor_vali_sat_link_film_head_actor_vali_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE data_vault.sat_link_film_head_actor_vali_sat_link_film_head_actor_vali_seq OWNER TO data_vault;

--
-- Name: sat_link_film_head_actor_vali_sat_link_film_head_actor_vali_seq; Type: SEQUENCE OWNED BY; Schema: data_vault; Owner: postgres
--

ALTER SEQUENCE data_vault.sat_link_film_head_actor_vali_sat_link_film_head_actor_vali_seq OWNED BY data_vault.sat_link_film_head_actor_valid.sat_link_film_head_actor_valid_id;


--
-- Name: sat_payment; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_payment (
    sat_key bytea NOT NULL,
    hub_payment_id bytea NOT NULL,
    load_dts timestamp without time zone,
    load_end_dts timestamp without time zone,
    record_source_id integer,
    amount numeric(5,2),
    payment_date timestamp without time zone,
    last_update timestamp without time zone,
    sat_attributes_concat bytea,

    CONSTRAINT chk_sat_payment_sat_key_len
        CHECK (octet_length(sat_key) = 32),

    CONSTRAINT chk_sat_payment_hub_payment_id_len
        CHECK (octet_length(hub_payment_id) = 32),

    CONSTRAINT chk_sat_payment_sat_attributes_concat_len
        CHECK (sat_attributes_concat IS NULL OR octet_length(sat_attributes_concat) = 32)
);


ALTER TABLE data_vault.sat_payment OWNER TO data_vault;



--
-- Name: sat_rental; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_rental (
    sat_key bytea NOT NULL,
    hub_rental_id bytea NOT NULL,
    load_dts timestamp without time zone,
    load_end_dts timestamp without time zone,
    record_source_id integer,
    rental_date timestamp without time zone,
    return_date timestamp without time zone,
    last_update timestamp without time zone,
    sat_attributes_concat bytea,

    CONSTRAINT chk_sat_rental_sat_key_len
        CHECK (octet_length(sat_key) = 32),

    CONSTRAINT chk_sat_rental_hub_rental_id_len
        CHECK (octet_length(hub_rental_id) = 32),

    CONSTRAINT chk_sat_rental_sat_attributes_concat_len
        CHECK (sat_attributes_concat IS NULL OR octet_length(sat_attributes_concat) = 32)
);


ALTER TABLE data_vault.sat_rental OWNER TO data_vault;



--
-- Name: sat_staff; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_staff (
    sat_key bytea NOT NULL,
    hub_staff_id bytea NOT NULL,
    load_dts timestamp without time zone,
    load_end_dts timestamp without time zone,
    record_source_id integer,
    first_name character varying(45),
    last_name character varying(45),
    email character varying(50),
    active integer,
    username character varying(16),
    password character varying(40),
    last_update timestamp without time zone,
    sat_attributes_concat bytea,
    tenant_id character varying(20) NOT NULL,

    CONSTRAINT chk_sat_staff_sat_key_len
        CHECK (octet_length(sat_key) = 32),

    CONSTRAINT chk_sat_staff_hub_staff_id_len
        CHECK (octet_length(hub_staff_id) = 32),

    CONSTRAINT chk_sat_staff_sat_attributes_concat_len
        CHECK (sat_attributes_concat IS NULL OR octet_length(sat_attributes_concat) = 32)
);


ALTER TABLE data_vault.sat_staff OWNER TO data_vault;

--
-- Name: sat_staff_err; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_staff_err (
    sat_key text DEFAULT '-1'::integer,
    hub_staff_id text,
    load_dts timestamp without time zone,
    load_end_dts text,
    record_source_id integer,
    first_name text,
    last_name text,
    email text,
    active text,
    username text,
    password text,
    last_update text,
    sat_attributes_concat text,
    tenant_id text,
    etl_err_date timestamp without time zone DEFAULT now(),
    etl_id_run integer,
    etl_err_noe integer,
    etl_err_desc character varying(512),
    etl_err_col character varying(256),
    etl_err_cod character varying(256)
);


ALTER TABLE data_vault.sat_staff_err OWNER TO data_vault;



--
-- Name: sat_staff_store_test; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_staff_store_test (
    sat_key bytea NOT NULL,
    link_staff_worksin_store_id bytea NOT NULL,
    load_dts timestamp without time zone,
    load_end_dts timestamp without time zone,
    record_source_id integer,
    username character varying(16),
    password character varying(40),
    sat_attributes_concat bytea,
    tenant_id character varying(20) NOT NULL,

    CONSTRAINT chk_sat_staff_store_test_sat_key_len
        CHECK (octet_length(sat_key) = 32),

    CONSTRAINT chk_sat_staff_store_test_link_staff_worksin_store_id_len
        CHECK (octet_length(link_staff_worksin_store_id) = 32),

    CONSTRAINT chk_sat_staff_store_test_sat_attributes_concat_len
        CHECK (
            sat_attributes_concat IS NULL
            OR octet_length(sat_attributes_concat) = 32
        )
);

ALTER TABLE data_vault.sat_staff_store_test OWNER TO data_vault;

--
-- Name: sat_staff_store_test_err; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_staff_store_test_err (
    sat_key text DEFAULT '-1'::integer,
    link_staff_worksin_store_id text,
    load_dts timestamp without time zone,
    load_end_dts text,
    record_source_id integer,
    username text,
    password text,
    sat_attributes_concat text,
    tenant_id text,
    etl_err_date timestamp without time zone DEFAULT now(),
    etl_id_run integer,
    etl_err_noe integer,
    etl_err_desc character varying(512),
    etl_err_col character varying(256),
    etl_err_cod character varying(256)
);


ALTER TABLE data_vault.sat_staff_store_test_err OWNER TO data_vault;



--
-- Name: sat_store; Type: TABLE; Schema: data_vault; Owner: postgres
--

CREATE TABLE data_vault.sat_store (
    sat_key bytea NOT NULL,
    hub_store_id bytea NOT NULL,
    load_dts timestamp without time zone,
    load_end_dts timestamp without time zone,
    record_source_id integer,
    last_update timestamp without time zone,
    sat_attributes_concat bytea,

    CONSTRAINT chk_sat_store_sat_key_len
        CHECK (octet_length(sat_key) = 32),

    CONSTRAINT chk_sat_store_hub_store_id_len
        CHECK (octet_length(hub_store_id) = 32),

    CONSTRAINT chk_sat_store_sat_attributes_concat_len
        CHECK (sat_attributes_concat IS NULL OR octet_length(sat_attributes_concat) = 32)
);


ALTER TABLE data_vault.sat_store OWNER TO data_vault;


















































--
-- Name: sat_link_film_actor_valid sat_link_film_actor_valid_id; Type: DEFAULT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_link_film_actor_valid ALTER COLUMN sat_link_film_actor_valid_id SET DEFAULT nextval('data_vault.sat_link_film_actor_valid_sat_link_film_actor_valid_id_seq'::regclass);


--
-- Name: sat_link_film_head_actor_valid sat_link_film_head_actor_valid_id; Type: DEFAULT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_link_film_head_actor_valid ALTER COLUMN sat_link_film_head_actor_valid_id SET DEFAULT nextval('data_vault.sat_link_film_head_actor_vali_sat_link_film_head_actor_vali_seq'::regclass);








--
-- Name: link_address_city bk; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_address_city
    ADD CONSTRAINT bk UNIQUE (hub_address_id, hub_city_id);


--
-- Name: link_city_country bk_link_city_country; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_city_country
    ADD CONSTRAINT bk_link_city_country UNIQUE (hub_city_id, hub_country_id);


--
-- Name: link_customer_address bk_link_customer_address; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_customer_address
    ADD CONSTRAINT bk_link_customer_address UNIQUE (hub_customer_id, hub_address_id);


--
-- Name: link_customer_store bk_link_customer_store; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_customer_store
    ADD CONSTRAINT bk_link_customer_store UNIQUE (hub_customer_id, hub_store_id);


--
-- Name: link_film_actor bk_link_film_actor; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_film_actor
    ADD CONSTRAINT bk_link_film_actor UNIQUE (hub_film_id, hub_actor_id);


--
-- Name: link_film_category bk_link_film_category; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_film_category
    ADD CONSTRAINT bk_link_film_category UNIQUE (hub_film_id, hub_category_id);


--
-- Name: link_film_head_actor bk_link_film_head_actor; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_film_head_actor
    ADD CONSTRAINT bk_link_film_head_actor UNIQUE (hub_film_id, hub_actor_id);


--
-- Name: link_film_language bk_link_film_language; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_film_language
    ADD CONSTRAINT bk_link_film_language UNIQUE (hub_film_id, hub_language_id, hub_language_id_original);


--
-- Name: link_inventory bk_link_inventory; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_inventory
    ADD CONSTRAINT bk_link_inventory UNIQUE (hub_inventory_id, hub_film_id, hub_store_id);


--
-- Name: link_payment bk_link_payment; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_payment
    ADD CONSTRAINT bk_link_payment UNIQUE (hub_payment_id, hub_customer_id, hub_staff_id);


--
-- Name: link_payment_rental bk_link_payment_rental; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_payment_rental
    ADD CONSTRAINT bk_link_payment_rental UNIQUE (hub_payment_id, hub_rental_id);


--
-- Name: link_rental bk_link_rental; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_rental
    ADD CONSTRAINT bk_link_rental UNIQUE (hub_rental_id, hub_customer_id, hub_staff_id, hub_inventory_id);


--
-- Name: link_staff_address bk_link_staff_address; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_staff_address
    ADD CONSTRAINT bk_link_staff_address UNIQUE (hub_staff_id, hub_address_id);


--
-- Name: link_staff_worksin_store bk_link_staff_worksin_store; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_staff_worksin_store
    ADD CONSTRAINT bk_link_staff_worksin_store UNIQUE (hub_staff_id, hub_store_id);


--
-- Name: link_store_address bk_link_store_address; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_store_address
    ADD CONSTRAINT bk_link_store_address UNIQUE (hub_store_id, hub_address_id);


--
-- Name: link_store_manager bk_link_store_manager; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_store_manager
    ADD CONSTRAINT bk_link_store_manager UNIQUE (hub_store_id, hub_staff_id);


--
-- Name: hub_actor hub_actor_bk; Type: CONSTRAINT; Schema: data_vault; Owner: pdi_meta
--

ALTER TABLE ONLY data_vault.hub_actor
    ADD CONSTRAINT hub_actor_bk UNIQUE (actor_id);


--
-- Name: hub_actor hub_actor_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: pdi_meta
--

ALTER TABLE ONLY data_vault.hub_actor
    ADD CONSTRAINT hub_actor_pkey PRIMARY KEY (hub_actor_id);


--
-- Name: hub_address hub_address_bk; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_address
    ADD CONSTRAINT hub_address_bk UNIQUE (address_id);


--
-- Name: hub_address hub_address_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_address
    ADD CONSTRAINT hub_address_pkey PRIMARY KEY (hub_address_id);


--
-- Name: hub_category hub_category_bk; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_category
    ADD CONSTRAINT hub_category_bk UNIQUE (category_id);


--
-- Name: hub_category hub_category_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_category
    ADD CONSTRAINT hub_category_pkey PRIMARY KEY (hub_category_id);


--
-- Name: hub_city hub_city_bk; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_city
    ADD CONSTRAINT hub_city_bk UNIQUE (city_id);


--
-- Name: hub_city hub_city_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_city
    ADD CONSTRAINT hub_city_pkey PRIMARY KEY (hub_city_id);


--
-- Name: hub_country hub_country_bk; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_country
    ADD CONSTRAINT hub_country_bk UNIQUE (country_id);


--
-- Name: hub_country hub_country_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_country
    ADD CONSTRAINT hub_country_pkey PRIMARY KEY (hub_country_id);


--
-- Name: hub_customer hub_customer_bk; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_customer
    ADD CONSTRAINT hub_customer_bk UNIQUE (customer_id);


--
-- Name: hub_customer hub_customer_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_customer
    ADD CONSTRAINT hub_customer_pkey PRIMARY KEY (hub_customer_id);


--
-- Name: hub_film hub_film_bk; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_film
    ADD CONSTRAINT hub_film_bk UNIQUE (film_id);


--
-- Name: hub_film hub_film_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_film
    ADD CONSTRAINT hub_film_pkey PRIMARY KEY (hub_film_id);


--
-- Name: hub_inventory hub_inventory_bk; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_inventory
    ADD CONSTRAINT hub_inventory_bk UNIQUE (inventory_id);


--
-- Name: hub_inventory hub_inventory_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_inventory
    ADD CONSTRAINT hub_inventory_pkey PRIMARY KEY (hub_inventory_id);


--
-- Name: hub_language hub_language_bk; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_language
    ADD CONSTRAINT hub_language_bk UNIQUE (language_id);


--
-- Name: hub_language hub_language_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_language
    ADD CONSTRAINT hub_language_pkey PRIMARY KEY (hub_language_id);


--
-- Name: hub_payment hub_payment_bk; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_payment
    ADD CONSTRAINT hub_payment_bk UNIQUE (payment_id);


--
-- Name: hub_payment hub_payment_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_payment
    ADD CONSTRAINT hub_payment_pkey PRIMARY KEY (hub_payment_id);


--
-- Name: hub_rental hub_rental_bk; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_rental
    ADD CONSTRAINT hub_rental_bk UNIQUE (rental_id);


--
-- Name: hub_rental hub_rental_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_rental
    ADD CONSTRAINT hub_rental_pkey PRIMARY KEY (hub_rental_id);


--
-- Name: hub_staff hub_staff_bk; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_staff
    ADD CONSTRAINT hub_staff_bk UNIQUE (staff_id);


--
-- Name: hub_staff hub_staff_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_staff
    ADD CONSTRAINT hub_staff_pkey PRIMARY KEY (hub_staff_id);


--
-- Name: hub_store hub_store_bk; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_store
    ADD CONSTRAINT hub_store_bk UNIQUE (store_id);


--
-- Name: hub_store hub_store_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.hub_store
    ADD CONSTRAINT hub_store_pkey PRIMARY KEY (hub_store_id);


--
-- Name: link_address_city ix_lkp_link_address_city; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_address_city
    ADD CONSTRAINT ix_lkp_link_address_city UNIQUE (hub_address_id, hub_city_id, link_address_city_id);


--
-- Name: link_city_country ix_lkp_link_city_country; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_city_country
    ADD CONSTRAINT ix_lkp_link_city_country UNIQUE (hub_city_id, hub_country_id, link_city_country_id);


--
-- Name: link_customer_address ix_lkp_link_customer_address; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_customer_address
    ADD CONSTRAINT ix_lkp_link_customer_address UNIQUE (hub_customer_id, hub_address_id, link_customer_address_id);


--
-- Name: link_customer_store ix_lkp_link_customer_store; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_customer_store
    ADD CONSTRAINT ix_lkp_link_customer_store UNIQUE (hub_customer_id, hub_store_id, link_customer_store_id);


--
-- Name: link_film_actor ix_lkp_link_film_actor; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_film_actor
    ADD CONSTRAINT ix_lkp_link_film_actor UNIQUE (hub_film_id, hub_actor_id, link_film_actor_id);


--
-- Name: link_film_category ix_lkp_link_film_category; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_film_category
    ADD CONSTRAINT ix_lkp_link_film_category UNIQUE (hub_film_id, hub_category_id, link_film_category_id);


--
-- Name: link_film_head_actor ix_lkp_link_film_head_actor; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_film_head_actor
    ADD CONSTRAINT ix_lkp_link_film_head_actor UNIQUE (hub_film_id, hub_actor_id, link_film_head_actor_id);


--
-- Name: link_film_language ix_lkp_link_film_language; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_film_language
    ADD CONSTRAINT ix_lkp_link_film_language UNIQUE (hub_film_id, hub_language_id, hub_language_id_original, link_film_language_id);


--
-- Name: link_inventory ix_lkp_link_inventory; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_inventory
    ADD CONSTRAINT ix_lkp_link_inventory UNIQUE (hub_inventory_id, hub_film_id, hub_store_id, link_inventory_id);


--
-- Name: link_payment ix_lkp_link_payment; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_payment
    ADD CONSTRAINT ix_lkp_link_payment UNIQUE (hub_payment_id, hub_customer_id, hub_staff_id, link_payment_id);


--
-- Name: link_payment_rental ix_lkp_link_payment_rental; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_payment_rental
    ADD CONSTRAINT ix_lkp_link_payment_rental UNIQUE (hub_payment_id, hub_rental_id, link_payment_rental_id);


--
-- Name: link_rental ix_lkp_link_rental; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_rental
    ADD CONSTRAINT ix_lkp_link_rental UNIQUE (hub_rental_id, hub_customer_id, hub_staff_id, hub_inventory_id, link_rental_id);


--
-- Name: link_staff_address ix_lkp_link_staff_address; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_staff_address
    ADD CONSTRAINT ix_lkp_link_staff_address UNIQUE (hub_staff_id, hub_address_id, link_staff_address_id);


--
-- Name: link_staff_worksin_store ix_lkp_link_staff_worksin_store; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_staff_worksin_store
    ADD CONSTRAINT ix_lkp_link_staff_worksin_store UNIQUE (hub_staff_id, hub_store_id, link_staff_worksin_store_id);


--
-- Name: link_store_address ix_lkp_link_store_address; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_store_address
    ADD CONSTRAINT ix_lkp_link_store_address UNIQUE (hub_store_id, hub_address_id, link_store_address_id);


--
-- Name: link_store_manager ix_lkp_link_store_manager; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_store_manager
    ADD CONSTRAINT ix_lkp_link_store_manager UNIQUE (hub_store_id, hub_staff_id, link_store_manager_id);


--
-- Name: sat_link_film_actor_valid ix_sat_link_film_actor_valid; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_link_film_actor_valid
    ADD CONSTRAINT ix_sat_link_film_actor_valid UNIQUE (load_dts, load_end_dts, record_source_id, ind_valid, link_film_actor_id);


--
-- Name: sat_link_film_head_actor_valid ix_sat_link_film_head_actor_valid; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_link_film_head_actor_valid
    ADD CONSTRAINT ix_sat_link_film_head_actor_valid UNIQUE (load_dts, load_end_dts, record_source_id, ind_valid, link_film_head_actor_id);


--
-- Name: link_address_city link_address_city_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_address_city
    ADD CONSTRAINT link_address_city_pkey PRIMARY KEY (link_address_city_id);


--
-- Name: link_city_country link_city_country_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_city_country
    ADD CONSTRAINT link_city_country_pkey PRIMARY KEY (link_city_country_id);


--
-- Name: link_customer_address link_customer_address_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_customer_address
    ADD CONSTRAINT link_customer_address_pkey PRIMARY KEY (link_customer_address_id);


--
-- Name: link_customer_store link_customer_store_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_customer_store
    ADD CONSTRAINT link_customer_store_pkey PRIMARY KEY (link_customer_store_id, tenant_id);


--
-- Name: link_film_actor link_film_actor_link_film_actor_id_tenant_id_pk; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_film_actor
    ADD CONSTRAINT link_film_actor_link_film_actor_id_tenant_id_pk PRIMARY KEY (link_film_actor_id, tenant_id);


--
-- Name: link_film_category link_film_category_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_film_category
    ADD CONSTRAINT link_film_category_pkey PRIMARY KEY (link_film_category_id);


--
-- Name: link_film_head_actor link_film_head_actor_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_film_head_actor
    ADD CONSTRAINT link_film_head_actor_pkey PRIMARY KEY (link_film_head_actor_id);


--
-- Name: link_film_language link_film_language_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_film_language
    ADD CONSTRAINT link_film_language_pkey PRIMARY KEY (link_film_language_id);


--
-- Name: link_inventory link_inventory_link_inventory_id_tenant_id_pk; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_inventory
    ADD CONSTRAINT link_inventory_link_inventory_id_tenant_id_pk PRIMARY KEY (link_inventory_id, tenant_id);


--
-- Name: link_payment link_payment_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_payment
    ADD CONSTRAINT link_payment_pkey PRIMARY KEY (link_payment_id);


--
-- Name: link_payment_rental link_payment_rental_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_payment_rental
    ADD CONSTRAINT link_payment_rental_pkey PRIMARY KEY (link_payment_rental_id);


--
-- Name: link_rental link_rental_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_rental
    ADD CONSTRAINT link_rental_pkey PRIMARY KEY (link_rental_id);


--
-- Name: link_staff_address link_staff_address_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_staff_address
    ADD CONSTRAINT link_staff_address_pkey PRIMARY KEY (link_staff_address_id);


--
-- Name: link_staff_worksin_store link_staff_worksin_store_link_staff_worksin_store_id_tenant_id_; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_staff_worksin_store
    ADD CONSTRAINT link_staff_worksin_store_link_staff_worksin_store_id_tenant_id_ PRIMARY KEY (link_staff_worksin_store_id, tenant_id);


--
-- Name: link_store_address link_store_address_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_store_address
    ADD CONSTRAINT link_store_address_pkey PRIMARY KEY (link_store_address_id);


--
-- Name: link_store_manager link_store_manager_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_store_manager
    ADD CONSTRAINT link_store_manager_pkey PRIMARY KEY (link_store_manager_id);


--
-- Name: sat_actor sat_actor_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_actor
    ADD CONSTRAINT sat_actor_pkey PRIMARY KEY (sat_key);


--
-- Name: sat_address sat_address_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_address
    ADD CONSTRAINT sat_address_pkey PRIMARY KEY (sat_key);


--
-- Name: sat_category sat_category_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_category
    ADD CONSTRAINT sat_category_pkey PRIMARY KEY (sat_key);


--
-- Name: sat_city sat_city_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_city
    ADD CONSTRAINT sat_city_pkey PRIMARY KEY (sat_key);


--
-- Name: sat_country sat_country_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_country
    ADD CONSTRAINT sat_country_pkey PRIMARY KEY (sat_key);


--
-- Name: sat_customer sat_customer_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_customer
    ADD CONSTRAINT sat_customer_pkey PRIMARY KEY (sat_key, tenant_id);


--
-- Name: sat_hub_film_status sat_hub_film_status_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_hub_film_status
    ADD CONSTRAINT sat_hub_film_status_pkey PRIMARY KEY (hub_film_id, tenant_id, record_source_id, ind_deleted, load_dts);


--
-- Name: sat_hub_film_surrogate_keys sat_hub_film_surrogate_keys_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_hub_film_surrogate_keys
    ADD CONSTRAINT sat_hub_film_surrogate_keys_pkey PRIMARY KEY (sat_key);


--
-- Name: sat_language sat_language_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_language
    ADD CONSTRAINT sat_language_pkey PRIMARY KEY (sat_key);


--
-- Name: sat_link_film_actor_status sat_link_film_actor_status_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_link_film_actor_status
    ADD CONSTRAINT sat_link_film_actor_status_pkey PRIMARY KEY (link_film_actor_id, record_source_id, ind_deleted, load_dts);


--
-- Name: sat_link_film_actor_valid sat_link_film_actor_valid_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_link_film_actor_valid
    ADD CONSTRAINT sat_link_film_actor_valid_pkey PRIMARY KEY (sat_link_film_actor_valid_id);


--
-- Name: sat_link_film_head_actor_valid sat_link_film_head_actor_valid_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_link_film_head_actor_valid
    ADD CONSTRAINT sat_link_film_head_actor_valid_pkey PRIMARY KEY (sat_link_film_head_actor_valid_id);


--
-- Name: sat_payment sat_payment_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_payment
    ADD CONSTRAINT sat_payment_pkey PRIMARY KEY (sat_key);


--
-- Name: sat_rental sat_rental_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_rental
    ADD CONSTRAINT sat_rental_pkey PRIMARY KEY (sat_key);


--
-- Name: sat_staff sat_staff_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_staff
    ADD CONSTRAINT sat_staff_pkey PRIMARY KEY (sat_key, tenant_id);


--
-- Name: sat_store sat_store_pkey; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_store
    ADD CONSTRAINT sat_store_pkey PRIMARY KEY (sat_key);


--
-- Name: sat_hub_film_surrogate_keys uk_sat_hub_film_surrogate_keys_hub_film; Type: CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_hub_film_surrogate_keys
    ADD CONSTRAINT uk_sat_hub_film_surrogate_keys_hub_film UNIQUE (hub_film_id, id_srcsys, source_surrogate_key, load_dts);


--
-- Name: ix_hub_actor_lkp; Type: INDEX; Schema: data_vault; Owner: pdi_meta
--

CREATE UNIQUE INDEX ix_hub_actor_lkp ON data_vault.hub_actor USING btree (actor_id, hub_actor_id);


--
-- Name: ix_hub_address_lkp; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE UNIQUE INDEX ix_hub_address_lkp ON data_vault.hub_address USING btree (address_id, hub_address_id);


--
-- Name: ix_hub_category_lkp; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE UNIQUE INDEX ix_hub_category_lkp ON data_vault.hub_category USING btree (category_id, hub_category_id);


--
-- Name: ix_hub_city_lkp; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE UNIQUE INDEX ix_hub_city_lkp ON data_vault.hub_city USING btree (city_id, hub_city_id);


--
-- Name: ix_hub_country_lkp; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE UNIQUE INDEX ix_hub_country_lkp ON data_vault.hub_country USING btree (country_id, hub_country_id);


--
-- Name: ix_hub_customer_lkp; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE UNIQUE INDEX ix_hub_customer_lkp ON data_vault.hub_customer USING btree (customer_id, hub_customer_id);


--
-- Name: ix_hub_film_id; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE INDEX ix_hub_film_id ON data_vault.hub_film_run USING btree (hub_film_id);


--
-- Name: ix_hub_film_lkp; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE UNIQUE INDEX ix_hub_film_lkp ON data_vault.hub_film USING btree (film_id, hub_film_id);


--
-- Name: ix_hub_inventory_lkp; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE UNIQUE INDEX ix_hub_inventory_lkp ON data_vault.hub_inventory USING btree (inventory_id, hub_inventory_id);


--
-- Name: ix_hub_language_lkp; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE UNIQUE INDEX ix_hub_language_lkp ON data_vault.hub_language USING btree (language_id, hub_language_id);


--
-- Name: ix_hub_payment_lkp; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE UNIQUE INDEX ix_hub_payment_lkp ON data_vault.hub_payment USING btree (payment_id, hub_payment_id);


--
-- Name: ix_hub_rental_lkp; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE UNIQUE INDEX ix_hub_rental_lkp ON data_vault.hub_rental USING btree (rental_id, hub_rental_id);


--
-- Name: ix_hub_staff_lkp; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE UNIQUE INDEX ix_hub_staff_lkp ON data_vault.hub_staff USING btree (staff_id, hub_staff_id);


--
-- Name: ix_hub_store_lkp; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE UNIQUE INDEX ix_hub_store_lkp ON data_vault.hub_store USING btree (store_id, hub_store_id);


--
-- Name: ix_link_film_actor_id; Type: INDEX; Schema: data_vault; Owner: data_vault
--

CREATE INDEX ix_link_film_actor_id ON data_vault.link_film_actor_run USING btree (link_film_actor_id);


--
-- Name: ix_link_film_head_actor_id; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE INDEX ix_link_film_head_actor_id ON data_vault.link_film_head_actor_run USING btree (link_film_head_actor_id);


--
-- Name: ix_link_film_head_actor_run; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE INDEX ix_link_film_head_actor_run ON data_vault.link_film_head_actor_run USING btree (record_source_id, load_dts, hub_film_id, hub_actor_id);


--
-- Name: ix_sat_payment_bk; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE INDEX ix_sat_payment_bk ON data_vault.sat_payment USING btree (hub_payment_id, load_dts);


--
-- Name: ix_sat_rental_bk; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE INDEX ix_sat_rental_bk ON data_vault.sat_rental USING btree (hub_rental_id, load_dts);


--
-- Name: link_film_actor_hub_actor_id_idx; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE INDEX link_film_actor_hub_actor_id_idx ON data_vault.link_film_actor USING btree (hub_actor_id);


--
-- Name: link_film_actor_hub_film_id_idx; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE INDEX link_film_actor_hub_film_id_idx ON data_vault.link_film_actor USING btree (hub_film_id);


--
-- Name: link_film_actor_link_film_actor_id_idx; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE INDEX link_film_actor_link_film_actor_id_idx ON data_vault.link_film_actor USING btree (link_film_actor_id);


--
-- Name: link_film_actor_tenant_id_idx; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE INDEX link_film_actor_tenant_id_idx ON data_vault.link_film_actor USING btree (tenant_id);


--
-- Name: sat_film_hub_film_id_idx; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE INDEX sat_film_hub_film_id_idx ON data_vault.sat_film USING btree (hub_film_id);


--
-- Name: sat_film_load_dts_idx; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE INDEX sat_film_load_dts_idx ON data_vault.sat_film USING btree (load_dts);


--
-- Name: sat_film_sat_attributes_concat_idx; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE INDEX sat_film_sat_attributes_concat_idx ON data_vault.sat_film USING btree (sat_attributes_concat);


--
-- Name: sat_film_sat_key_idx; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE INDEX sat_film_sat_key_idx ON data_vault.sat_film USING btree (sat_key);


--
-- Name: sat_film_tenant_id_idx; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE INDEX sat_film_tenant_id_idx ON data_vault.sat_film USING btree (tenant_id);


--
-- Name: sat_staff_store_test_sat_key_uindex; Type: INDEX; Schema: data_vault; Owner: postgres
--

CREATE UNIQUE INDEX sat_staff_store_test_sat_key_uindex ON data_vault.sat_staff_store_test USING btree (sat_key);


--
-- Name: link_address_city fk_link_address_city_hub_address; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_address_city
    ADD CONSTRAINT fk_link_address_city_hub_address FOREIGN KEY (hub_address_id) REFERENCES data_vault.hub_address(hub_address_id);


--
-- Name: link_address_city fk_link_address_city_hub_city; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_address_city
    ADD CONSTRAINT fk_link_address_city_hub_city FOREIGN KEY (hub_city_id) REFERENCES data_vault.hub_city(hub_city_id);


--
-- Name: link_city_country fk_link_city_country_hub_city; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_city_country
    ADD CONSTRAINT fk_link_city_country_hub_city FOREIGN KEY (hub_city_id) REFERENCES data_vault.hub_city(hub_city_id);


--
-- Name: link_city_country fk_link_city_country_hub_country; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_city_country
    ADD CONSTRAINT fk_link_city_country_hub_country FOREIGN KEY (hub_country_id) REFERENCES data_vault.hub_country(hub_country_id);


--
-- Name: link_customer_address fk_link_customer_address_hub_address; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_customer_address
    ADD CONSTRAINT fk_link_customer_address_hub_address FOREIGN KEY (hub_address_id) REFERENCES data_vault.hub_address(hub_address_id);


--
-- Name: link_film_category fk_link_film_category_hub_category; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_film_category
    ADD CONSTRAINT fk_link_film_category_hub_category FOREIGN KEY (hub_category_id) REFERENCES data_vault.hub_category(hub_category_id);


--
-- Name: link_film_language fk_link_film_language_hub_language; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_film_language
    ADD CONSTRAINT fk_link_film_language_hub_language FOREIGN KEY (hub_language_id) REFERENCES data_vault.hub_language(hub_language_id);


--
-- Name: link_film_language fk_link_film_language_hub_language_original; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_film_language
    ADD CONSTRAINT fk_link_film_language_hub_language_original FOREIGN KEY (hub_language_id_original) REFERENCES data_vault.hub_language(hub_language_id);


--
-- Name: link_payment fk_link_payment_hub_payment; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_payment
    ADD CONSTRAINT fk_link_payment_hub_payment FOREIGN KEY (hub_payment_id) REFERENCES data_vault.hub_payment(hub_payment_id);


--
-- Name: link_payment_rental fk_link_payment_rental_hub_payment; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_payment_rental
    ADD CONSTRAINT fk_link_payment_rental_hub_payment FOREIGN KEY (hub_payment_id) REFERENCES data_vault.hub_payment(hub_payment_id);


--
-- Name: link_payment_rental fk_link_payment_rental_hub_rental; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_payment_rental
    ADD CONSTRAINT fk_link_payment_rental_hub_rental FOREIGN KEY (hub_rental_id) REFERENCES data_vault.hub_rental(hub_rental_id);


--
-- Name: link_rental fk_link_rental_hub_rental; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_rental
    ADD CONSTRAINT fk_link_rental_hub_rental FOREIGN KEY (hub_rental_id) REFERENCES data_vault.hub_rental(hub_rental_id);


--
-- Name: link_staff_address fk_link_staff_address_hub_address; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_staff_address
    ADD CONSTRAINT fk_link_staff_address_hub_address FOREIGN KEY (hub_address_id) REFERENCES data_vault.hub_address(hub_address_id);


--
-- Name: link_store_address fk_link_store_address_hub_address; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.link_store_address
    ADD CONSTRAINT fk_link_store_address_hub_address FOREIGN KEY (hub_address_id) REFERENCES data_vault.hub_address(hub_address_id);


--
-- Name: sat_address fk_sat_address_hub_address; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_address
    ADD CONSTRAINT fk_sat_address_hub_address FOREIGN KEY (hub_address_id) REFERENCES data_vault.hub_address(hub_address_id);


--
-- Name: sat_category fk_sat_category_hub_category; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_category
    ADD CONSTRAINT fk_sat_category_hub_category FOREIGN KEY (hub_category_id) REFERENCES data_vault.hub_category(hub_category_id);


--
-- Name: sat_city fk_sat_city_hub_city; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_city
    ADD CONSTRAINT fk_sat_city_hub_city FOREIGN KEY (hub_city_id) REFERENCES data_vault.hub_city(hub_city_id);


--
-- Name: sat_country fk_sat_country_hub_country; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_country
    ADD CONSTRAINT fk_sat_country_hub_country FOREIGN KEY (hub_country_id) REFERENCES data_vault.hub_country(hub_country_id);


--
-- Name: sat_language fk_sat_language_hub_language; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_language
    ADD CONSTRAINT fk_sat_language_hub_language FOREIGN KEY (hub_language_id) REFERENCES data_vault.hub_language(hub_language_id);


--
-- Name: sat_payment fk_sat_payment_hub_payment; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_payment
    ADD CONSTRAINT fk_sat_payment_hub_payment FOREIGN KEY (hub_payment_id) REFERENCES data_vault.hub_payment(hub_payment_id);


--
-- Name: sat_rental fk_sat_rental_hub_rental; Type: FK CONSTRAINT; Schema: data_vault; Owner: postgres
--

ALTER TABLE ONLY data_vault.sat_rental
    ADD CONSTRAINT fk_sat_rental_hub_rental FOREIGN KEY (hub_rental_id) REFERENCES data_vault.hub_rental(hub_rental_id);


RESET ROLE;

SET ROLE pdi_meta;

set search_path to pdi_meta, pg_catalog;

TRUNCATE TABLE pdi_meta.ref_connections CASCADE;
INSERT INTO pdi_meta.ref_connections VALUES ('1', 'sakila', 'MySQL', 'Sakila Source', 'mysql', 'sakila', '3306', 'sakila', 'sourcesecret', '');
INSERT INTO pdi_meta.ref_connections VALUES ('2', 'staging', 'PostgreSQL', 'Staging conn', 'postgres', 'staging', '5432', 'staging', 'secret', '');

RESET ROLE;
