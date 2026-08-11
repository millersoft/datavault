-- Millersoft packaged Sakila demo only.
-- The official MySQL entrypoint creates the MYSQL_USER account before it runs
-- files in /docker-entrypoint-initdb.d. This grants that existing demo source
-- account access to the future Data Vault output database. It does not create
-- the database; Studio creates `datavault` on demand when FDW is selected.
GRANT CREATE, ALTER, INDEX, SELECT, INSERT, UPDATE, DELETE
ON `datavault`.*
TO 'sakila'@'%';
