-- =====================================================
-- Sakila ID widening for load testing
-- Purpose: remove Sakila's demo-size SMALLINT/MEDIUMINT ceilings
--          from the high-volume tables used by the batch generator.
--
-- Use INT UNSIGNED by default:
--   max value = 4,294,967,295
-- If your target supports 64-bit IDs and you genuinely want to push
-- beyond that, replace INT UNSIGNED with BIGINT UNSIGNED consistently.
--
-- Run once on a disposable/load-test Sakila database.
-- =====================================================

USE sakila;

SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS;
SET FOREIGN_KEY_CHECKS=0;

SELECT '=== Dropping FKs that reference columns being widened ===' AS status;

ALTER TABLE film_actor   DROP FOREIGN KEY fk_film_actor_actor;
ALTER TABLE film_actor   DROP FOREIGN KEY fk_film_actor_film;
ALTER TABLE film_category DROP FOREIGN KEY fk_film_category_film;
ALTER TABLE inventory    DROP FOREIGN KEY fk_inventory_film;
ALTER TABLE rental       DROP FOREIGN KEY fk_rental_inventory;
ALTER TABLE rental       DROP FOREIGN KEY fk_rental_customer;
ALTER TABLE payment      DROP FOREIGN KEY fk_payment_customer;

SELECT '=== Widening parent IDs ===' AS status;

ALTER TABLE actor
    MODIFY actor_id INT UNSIGNED NOT NULL AUTO_INCREMENT;

ALTER TABLE customer
    MODIFY customer_id INT UNSIGNED NOT NULL AUTO_INCREMENT;

ALTER TABLE film
    MODIFY film_id INT UNSIGNED NOT NULL AUTO_INCREMENT;

ALTER TABLE inventory
    MODIFY inventory_id INT UNSIGNED NOT NULL AUTO_INCREMENT;

-- Optional, but recommended if you later generate payment rows.
ALTER TABLE payment
    MODIFY payment_id INT UNSIGNED NOT NULL AUTO_INCREMENT;

SELECT '=== Widening child/reference columns ===' AS status;

ALTER TABLE film_actor
    MODIFY actor_id INT UNSIGNED NOT NULL,
    MODIFY film_id  INT UNSIGNED NOT NULL;

ALTER TABLE film_category
    MODIFY film_id INT UNSIGNED NOT NULL;

-- film_text is maintained by triggers from film. It must be widened too.
ALTER TABLE film_text
    MODIFY film_id INT UNSIGNED NOT NULL;

ALTER TABLE inventory
    MODIFY film_id INT UNSIGNED NOT NULL;

ALTER TABLE rental
    MODIFY inventory_id INT UNSIGNED NOT NULL,
    MODIFY customer_id  INT UNSIGNED NOT NULL;

ALTER TABLE payment
    MODIFY customer_id INT UNSIGNED NOT NULL;

SELECT '=== Recreating FKs ===' AS status;

ALTER TABLE film_actor
    ADD CONSTRAINT fk_film_actor_actor
        FOREIGN KEY (actor_id) REFERENCES actor (actor_id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT fk_film_actor_film
        FOREIGN KEY (film_id) REFERENCES film (film_id)
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE film_category
    ADD CONSTRAINT fk_film_category_film
        FOREIGN KEY (film_id) REFERENCES film (film_id)
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE inventory
    ADD CONSTRAINT fk_inventory_film
        FOREIGN KEY (film_id) REFERENCES film (film_id)
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE rental
    ADD CONSTRAINT fk_rental_inventory
        FOREIGN KEY (inventory_id) REFERENCES inventory (inventory_id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT fk_rental_customer
        FOREIGN KEY (customer_id) REFERENCES customer (customer_id)
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE payment
    ADD CONSTRAINT fk_payment_customer
        FOREIGN KEY (customer_id) REFERENCES customer (customer_id)
        ON DELETE RESTRICT ON UPDATE CASCADE;

SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;

SELECT '=== ID widening complete ===' AS status;

SELECT
    table_name,
    column_name,
    column_type,
    extra
FROM information_schema.columns
WHERE table_schema = 'sakila'
  AND table_name IN ('actor','customer','film','film_actor','film_category','film_text','inventory','rental','payment')
  AND column_name IN ('actor_id','customer_id','film_id','inventory_id','payment_id')
ORDER BY table_name, ordinal_position;
