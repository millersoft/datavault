USE sakila;

SELECT '=== AUTO_INCREMENT HEALTHCHECK ===' AS status;

SELECT
    c.table_name,
    c.column_name,
    c.column_type,
    t.auto_increment,
    CASE
        WHEN c.data_type = 'tinyint'   AND c.column_type LIKE '%unsigned%' THEN 255
        WHEN c.data_type = 'smallint'  AND c.column_type LIKE '%unsigned%' THEN 65535
        WHEN c.data_type = 'mediumint' AND c.column_type LIKE '%unsigned%' THEN 16777215
        WHEN c.data_type IN ('int','integer') AND c.column_type LIKE '%unsigned%' THEN 4294967295
        WHEN c.data_type = 'bigint'    AND c.column_type LIKE '%unsigned%' THEN NULL
        WHEN c.data_type = 'tinyint'   THEN 127
        WHEN c.data_type = 'smallint'  THEN 32767
        WHEN c.data_type = 'mediumint' THEN 8388607
        WHEN c.data_type IN ('int','integer') THEN 2147483647
        WHEN c.data_type = 'bigint'    THEN NULL
        ELSE NULL
    END AS type_max_value
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema
 AND t.table_name   = c.table_name
WHERE c.table_schema = 'sakila'
  AND c.extra LIKE '%auto_increment%'
ORDER BY c.table_name;

SELECT
    (SELECT COUNT(*) FROM actor)      AS actor_count,
    (SELECT MAX(actor_id) FROM actor) AS actor_max_id,
    (SELECT AUTO_INCREMENT FROM information_schema.tables WHERE table_schema='sakila' AND table_name='actor') AS actor_next_ai,
    (SELECT COUNT(*) FROM customer)      AS customer_count,
    (SELECT MAX(customer_id) FROM customer) AS customer_max_id,
    (SELECT AUTO_INCREMENT FROM information_schema.tables WHERE table_schema='sakila' AND table_name='customer') AS customer_next_ai,
    (SELECT COUNT(*) FROM film)      AS film_count,
    (SELECT MAX(film_id) FROM film) AS film_max_id,
    (SELECT AUTO_INCREMENT FROM information_schema.tables WHERE table_schema='sakila' AND table_name='film') AS film_next_ai,
    (SELECT COUNT(*) FROM inventory)      AS inventory_count,
    (SELECT MAX(inventory_id) FROM inventory) AS inventory_max_id,
    (SELECT AUTO_INCREMENT FROM information_schema.tables WHERE table_schema='sakila' AND table_name='inventory') AS inventory_next_ai;

SHOW VARIABLES LIKE 'innodb_autoinc_lock_mode';
