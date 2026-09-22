#!/bin/bash
# One database per service. Services never share a database.
set -e

DATABASES="accounting assets audit automation bi billing catalog compliance contracts
crm devices discuss documents ecommerce erp expenses fieldservice files
helpdesk hr iam identity integrations invoicing knowledge learning mail
maintenance manufacturing marketing meetings notifier partners payroll
planning pos quality quotes recruitment search sign social subscriptions
surveys tasks tenancy"

for db in $DATABASES; do
  echo "  creating database nexus_${db}"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
    CREATE DATABASE nexus_${db};
EOSQL
done

echo "created $(echo $DATABASES | wc -w) service databases"
