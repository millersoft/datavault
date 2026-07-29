-- =====================================================
-- SAKILA LOAD TEST DATA GENERATOR - EXPLICIT IDS
-- =====================================================
-- Inserts exactly 10,000 new rows into each high-volume table:
--   actor, customer, film, film_actor, inventory
--
-- Recommended: run sakila_widen_for_loadtest.sql first.
-- =====================================================

USE sakila;

SET @batch_size := 10000;

SELECT CONCAT('=== Starting explicit-ID load test batch: ', @batch_size, ' rows per table ===') AS status;

-- -----------------------------------------------------
-- Build a reusable sequence 1..@batch_size.
-- This supports up to 100,000 per batch because it uses five digits.
--
-- The DROP is safe and useful when running this SQL manually in the same
-- MySQL session. sql_notes is temporarily disabled so mysql --show-warnings
-- does not print a noisy "Unknown table load_seq" note on a fresh session.
-- -----------------------------------------------------
SET @old_sql_notes := @@SESSION.sql_notes;
SET SESSION sql_notes = 0;
DROP TEMPORARY TABLE IF EXISTS load_seq;
SET SESSION sql_notes = @old_sql_notes;

CREATE TEMPORARY TABLE load_seq (
    n INT UNSIGNED NOT NULL PRIMARY KEY
) ENGINE=MEMORY;

INSERT INTO load_seq (n)
SELECT x + 1 AS n
FROM (
    SELECT
        d0.i
        + d1.i * 10
        + d2.i * 100
        + d3.i * 1000
        + d4.i * 10000 AS x
    FROM
        (SELECT 0 AS i UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) AS d0
    CROSS JOIN
        (SELECT 0 AS i UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) AS d1
    CROSS JOIN
        (SELECT 0 AS i UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) AS d2
    CROSS JOIN
        (SELECT 0 AS i UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) AS d3
    CROSS JOIN
        (SELECT 0 AS i UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) AS d4
) AS seq
WHERE x < @batch_size
ORDER BY n;

SELECT CONCAT('sequence rows available: ', COUNT(*)) AS status FROM load_seq;

-- Keep reference-table usage deliberately simple and deterministic.
-- Reusing one valid store/address is fine for volume testing and avoids
-- expensive ORDER BY RAND() calls in every row.
SET @load_store_id   := (SELECT MIN(store_id) FROM store);
SET @load_address_id := (SELECT MIN(address_id) FROM address);

SELECT CONCAT('using store_id=', @load_store_id, ', address_id=', @load_address_id) AS status;

START TRANSACTION;

-- Capture bases before inserting, so child rows can point at this batch's new parents.
SET @actor_base     := (SELECT COALESCE(MAX(actor_id), 0) FROM actor);
SET @customer_base  := (SELECT COALESCE(MAX(customer_id), 0) FROM customer);
SET @film_base      := (SELECT COALESCE(MAX(film_id), 0) FROM film);
SET @inventory_base := (SELECT COALESCE(MAX(inventory_id), 0) FROM inventory);

-- =====================================================
-- 1. ACTOR
-- =====================================================
INSERT INTO actor (actor_id, first_name, last_name, last_update)
SELECT
    @actor_base + s.n AS actor_id,
    CONCAT('First', @actor_base + s.n) AS first_name,
    CONCAT('Last',  @actor_base + s.n) AS last_name,
    NOW() AS last_update
FROM load_seq AS s;

SELECT CONCAT('actor rows inserted: ', ROW_COUNT()) AS status;

-- =====================================================
-- 2. CUSTOMER
-- =====================================================
INSERT INTO customer (customer_id, store_id, first_name, last_name, email, address_id, active, create_date, last_update)
SELECT
    @customer_base + s.n AS customer_id,
    @load_store_id AS store_id,
    CONCAT('CustF', @customer_base + s.n) AS first_name,
    CONCAT('CustL', @customer_base + s.n) AS last_name,
    CONCAT('customer', @customer_base + s.n, '@test.com') AS email,
    @load_address_id AS address_id,
    1 AS active,
    NOW() - INTERVAL MOD(@customer_base + s.n, 730) DAY AS create_date,
    NOW() AS last_update
FROM load_seq AS s;

SELECT CONCAT('customer rows inserted: ', ROW_COUNT()) AS status;

-- =====================================================
-- 3. FILM
-- =====================================================
INSERT INTO film (film_id, title, description, release_year, language_id, original_language_id,
                  rental_duration, rental_rate, length, replacement_cost, rating,
                  special_features, last_update)
SELECT
    @film_base + s.n AS film_id,
    CONCAT('Film ', @film_base + s.n) AS title,
    CONCAT('Load test film description for film ', @film_base + s.n, '.') AS description,
    2000 + MOD(@film_base + s.n, 25) AS release_year,
    1 AS language_id,
    NULL AS original_language_id,
    3 + MOD(@film_base + s.n, 5) AS rental_duration,
    ROUND(0.99 + MOD(@film_base + s.n, 400) / 100, 2) AS rental_rate,
    60 + MOD(@film_base + s.n, 140) AS length,
    ROUND(9.99 + MOD(@film_base + s.n, 2000) / 100, 2) AS replacement_cost,
    CASE MOD(@film_base + s.n, 5)
        WHEN 0 THEN 'G'
        WHEN 1 THEN 'PG'
        WHEN 2 THEN 'PG-13'
        WHEN 3 THEN 'R'
        ELSE 'NC-17'
    END AS rating,
    'Trailers,Commentaries,Deleted Scenes' AS special_features,
    NOW() AS last_update
FROM load_seq AS s;

SELECT CONCAT('film rows inserted: ', ROW_COUNT()) AS status;

-- =====================================================
-- 4. FILM_ACTOR
-- Creates one deterministic relationship for each newly-created actor/film pair.
-- =====================================================
INSERT INTO film_actor (actor_id, film_id, last_update)
SELECT
    @actor_base + s.n AS actor_id,
    @film_base + s.n AS film_id,
    NOW() AS last_update
FROM load_seq AS s;

SELECT CONCAT('film_actor rows inserted: ', ROW_COUNT()) AS status;

-- =====================================================
-- 5. INVENTORY
-- Creates one inventory row for each newly-created film.
-- =====================================================
INSERT INTO inventory (inventory_id, film_id, store_id, last_update)
SELECT
    @inventory_base + s.n AS inventory_id,
    @film_base + s.n AS film_id,
    @load_store_id AS store_id,
    NOW() AS last_update
FROM load_seq AS s;

SELECT CONCAT('inventory rows inserted: ', ROW_COUNT()) AS status;

COMMIT;

-- -----------------------------------------------------
-- Final summary
-- -----------------------------------------------------
SELECT '=== EXPLICIT-ID LOAD TEST BATCH COMPLETE ===' AS status;

SELECT
    (SELECT COUNT(*) FROM actor)       AS actor_total,
    (SELECT MAX(actor_id) FROM actor)  AS actor_max_id,
    (SELECT COUNT(*) FROM customer)    AS customer_total,
    (SELECT MAX(customer_id) FROM customer) AS customer_max_id,
    (SELECT COUNT(*) FROM film)        AS film_total,
    (SELECT MAX(film_id) FROM film)    AS film_max_id,
    (SELECT COUNT(*) FROM film_actor)  AS film_actor_total,
    (SELECT COUNT(*) FROM inventory)   AS inventory_total,
    (SELECT MAX(inventory_id) FROM inventory) AS inventory_max_id;
