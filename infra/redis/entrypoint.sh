#!/bin/sh
set -eu
sed -e "s|__ADMIN_PW__|$REDIS_ADMIN_PASSWORD|" -e "s|__JUDGE_PW__|$REDIS_JUDGE_PASSWORD|" -e "s|__API_PW__|$REDIS_API_PASSWORD|" \
  /etc/redis/users.acl.tmpl > /tmp/users.acl
exec redis-server --aclfile /tmp/users.acl --appendonly yes --dir /data
