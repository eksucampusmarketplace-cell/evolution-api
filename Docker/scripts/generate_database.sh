#!/bin/bash

source ./Docker/scripts/env_functions.sh

if [ "$DOCKER_ENV" != "true" ]; then
    export_env_vars
fi

# Map DATABASE_URL to DATABASE_CONNECTION_URI when not explicitly set.
# PaaS platforms (Render, Railway, etc.) typically provide DATABASE_URL,
# but Prisma schemas in this project read DATABASE_CONNECTION_URI.
if [ -z "$DATABASE_CONNECTION_URI" ] && [ -n "$DATABASE_URL" ]; then
    export DATABASE_CONNECTION_URI="$DATABASE_URL"
fi

# For psql_bouncer provider: map DATABASE_URL to DATABASE_BOUNCER_CONNECTION_URI
# when not explicitly set, so the pgbouncer-aware schema can resolve it.
if [ "$DATABASE_PROVIDER" == "psql_bouncer" ]; then
    if [ -z "$DATABASE_BOUNCER_CONNECTION_URI" ] && [ -n "$DATABASE_URL" ]; then
        export DATABASE_BOUNCER_CONNECTION_URI="$DATABASE_URL"
    fi
fi

if [[ "$DATABASE_PROVIDER" == "postgresql" || "$DATABASE_PROVIDER" == "mysql" || "$DATABASE_PROVIDER" == "psql_bouncer" ]]; then
    export DATABASE_URL
    echo "Generating database for $DATABASE_PROVIDER"
    echo "Database URL: $DATABASE_URL"
    npm run db:generate
    if [ $? -ne 0 ]; then
        echo "Prisma generate failed"
        exit 1
    else
        echo "Prisma generate succeeded"
    fi
else
    echo "Error: Database provider $DATABASE_PROVIDER invalid."
    exit 1
fi