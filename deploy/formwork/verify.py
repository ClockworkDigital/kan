#!/usr/bin/env python3
"""Exercise the real Kan image and Formwork policy in disposable loopback containers."""
import http.client
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
PLATFORM = ROOT.parent / 'formwork'
os.chdir(ROOT)

def run(args, text=None, env=None):
    result = subprocess.run(list(map(str, args)), input=text, text=True, capture_output=True, env=env)
    assert result.returncode == 0, result.stderr + result.stdout
    return result.stdout.strip()

def uid(number):
    return f'10000000-0000-4000-8000-{number:012d}'

image = os.environ.get('KAN_TEST_IMAGE', 'kan:formwork-poc')
platform_image = run(['docker', 'inspect', 'formwork-auth0-demo-formwork-1', '--format', '{{.Image}}'])
operations_image = os.environ.get('FORMWORK_OPERATIONS_IMAGE', 'formwork-operations:validation')
project = 'kan-check-' + secrets.token_hex(4)
password = secrets.token_hex(24)

with tempfile.TemporaryDirectory(prefix=project) as folder:
    scratch = Path(folder)
    (scratch / 'Caddyfile').write_text('''{
  auto_https off
}
import /etc/caddy/gateway.caddy
http://:8080 {
  route {
    import /etc/caddy/kan.caddy
    respond 404
  }
}
''')
    environment = {
        'ENTRA_TENANT_ID': uid(1), 'ENTRA_STAFF_GROUP_ID': uid(4),
        'FORMWORK_HOST': 'formwork.localhost', 'TOOL_DOMAIN': 'localhost',
        'DATABASE_URL': f'postgresql://formwork_owner:{password}@postgres:5432/formwork',
        'GATEWAY_SHARED_SECRET': password,
    }
    compose = {
        'services': {
            'postgres': {
                'image': 'postgres:18.6-bookworm', 'environment': {
                    'POSTGRES_USER': 'formwork_owner', 'POSTGRES_PASSWORD': password, 'POSTGRES_DB': 'formwork'},
                'networks': ['platform_db', 'kan_db'],
                'healthcheck': {'test': ['CMD-SHELL', 'pg_isready -U formwork_owner -d formwork'], 'interval': '2s', 'retries': 30},
            },
            'operations': {'image': operations_image, 'environment': environment, 'networks': ['platform_db']},
            'formwork': {'image': platform_image, 'environment': environment, 'networks': ['auth', 'platform_db']},
            'oauth2-proxy': {
                'image': 'node:24.22.1-bookworm-slim', 'command': ['node', '/identity.mjs'],
                'volumes': [f'{PLATFORM}/deploy/prototype/identity.mjs:/identity.mjs:ro'], 'networks': ['auth'],
            },
            'kan': {
                'image': image, 'environment': {
                    'POSTGRES_URL': f'postgresql://formwork_owner:{password}@postgres:5432/kan',
                    'BETTER_AUTH_SECRET': password, 'KAN_ADMIN_API_KEY': password,
                    'FORMWORK_TENANT_ID': uid(1), 'NEXT_PUBLIC_BASE_URL': 'https://kan.localhost',
                    'NEXT_PUBLIC_FORMWORK_URL': 'https://formwork.localhost',
                    'NEXT_PUBLIC_ALLOW_CREDENTIALS': 'false', 'NEXT_PUBLIC_DISABLE_SIGN_UP': 'true',
                    'NEXT_PUBLIC_DISABLE_EMAIL': 'true',
                }, 'networks': ['kan', 'kan_db'],
            },
            'caddy': {
                'image': 'caddy:2.11.7-alpine', 'ports': ['127.0.0.1::8080'],
                'environment': {'KAN_HOST': 'kan.localhost', 'FORMWORK_HOST': 'formwork.localhost', 'GATEWAY_SHARED_SECRET': password},
                'volumes': [f'{scratch}/Caddyfile:/etc/caddy/Caddyfile:ro',
                            f'{PLATFORM}/deploy/gateway.caddy:/etc/caddy/gateway.caddy:ro',
                            f'{PLATFORM}/deploy/auth0/kan.caddy:/etc/caddy/kan.caddy:ro'],
                'networks': ['auth', 'kan', 'edge'],
            },
        },
        'networks': {name: {'internal': name != 'edge'} for name in ['auth', 'platform_db', 'kan', 'kan_db', 'edge']},
    }
    # Small explicit ranges avoid consuming the host's default Docker address pools.
    octet = secrets.randbelow(240)
    for index, network in enumerate(compose['networks'].values()):
        network['ipam'] = {'config': [{'subnet': f'10.247.{octet}.{index * 16}/28'}]}
    filename = scratch / 'compose.json'
    filename.write_text(json.dumps(compose))
    command = ['docker', 'compose', '-p', project, '-f', filename]
    def dc(*args): return run(command + list(args))
    def sql(statement, database='formwork'):
        return run(command + ['exec', '-T', 'postgres', 'psql', '-X', '-U', 'formwork_owner', '-d', database, '-At', '-v', 'ON_ERROR_STOP=1'], statement)
    try:
        dc('up', '-d', '--wait', 'postgres')
        dc('run', '--rm', 'operations')
        sql('CREATE DATABASE kan;')
        container = json.loads(run(['docker', 'inspect', dc('ps', '-q', 'postgres')]))[0]
        ip = container['NetworkSettings']['Networks'][project + '_kan_db']['IPAddress']
        operator_env = {**os.environ, 'POSTGRES_URL': f'postgresql://formwork_owner:{password}@{ip}:5432/kan',
                        'BETTER_AUTH_SECRET': password, 'NEXT_PUBLIC_BASE_URL': 'https://kan.localhost', 'FORMWORK_TENANT_ID': uid(1)}
        run(['node', '-e', "const{Pool}=require('pg');const{drizzle}=require('drizzle-orm/node-postgres');const{migrate}=require('drizzle-orm/node-postgres/migrator');const p=new Pool({connectionString:process.env.POSTGRES_URL});migrate(drizzle(p),{migrationsFolder:'packages/db/migrations'}).finally(()=>p.end());"], env=operator_env)
        approved = scratch / 'approved.json'
        approved.write_text(json.dumps([{'id': uid(n), 'name': f'Test admin {n}', 'email': f'admin{n}@example.test'} for n in [2, 3]]))
        run(['node', 'node_modules/vite-node/vite-node.mjs', 'deploy/formwork/provision.ts', approved], env=operator_env)
        def issue(number, groups=None):
            grant = scratch / f'grant-{number}.json'
            profile = scratch / f'mcp-{number}.json'
            grant.write_text(json.dumps({'purpose': 'formwork-kan-mcp', 'tenantId': uid(1), 'userId': uid(2),
                'groups': groups or [uid(4), uid(5)], 'accountType': '0', 'issuedAt': int(time.time()), 'targetHost': 'kan.localhost'}))
            run(['node', 'node_modules/vite-node/vite-node.mjs', 'deploy/formwork/issue-mcp.ts', grant, profile], env=operator_env)
            return json.loads(profile.read_text())
        credential = issue(1)
        revoked = issue(2)
        expired = issue(3)
        denied = issue(4, [uid(4), uid(6)])
        stale = issue(5)
        sql(f'UPDATE "apiKey" SET enabled=false WHERE id={int(revoked["keyId"])};', 'kan')
        sql(f'UPDATE "apiKey" SET "expiresAt"=now()-interval \'1 second\' WHERE id={int(expired["keyId"])};', 'kan')
        # Better Auth's API-key plugin and adapter both serialize this text field.
        stored = json.loads(sql(f'SELECT metadata FROM "apiKey" WHERE id={int(stale["keyId"])};', 'kan'))
        assert isinstance(stored, str)
        old_grant = json.loads(stored)
        old_grant['issuedAt'] = int(time.time()) - 28801
        encoded = json.dumps(json.dumps(old_grant)).replace("'", "''")
        sql(f'UPDATE "apiKey" SET metadata=\'{encoded}\' WHERE id={int(stale["keyId"])};', 'kan')
        sql(f"INSERT INTO tools(id,slug,name,description,hostname,enabled,visible) VALUES('{uid(7)}','kan','Kan','Department','kan.localhost',true,true); INSERT INTO tool_groups(tool_id,group_id) VALUES('{uid(7)}','{uid(5)}');")
        dc('up', '-d', 'formwork', 'oauth2-proxy', 'kan', 'caddy')
        port = int(dc('port', 'caddy', '8080').rsplit(':', 1)[1])
        def request(path, identity='admin', body=None, extra=None):
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=15)
            headers = {'Host': 'kan.localhost', 'X-Prototype-Identity': identity, **(extra or {})}
            if body is not None: headers['Content-Type'] = 'application/json'
            connection.request('GET' if body is None else 'POST', path, json.dumps(body) if body is not None else None, headers)
            response = connection.getresponse()
            result = response.status, response.read().decode(), dict(response.getheaders())
            connection.close()
            return result
        # docker exec waits for readiness without publishing either backend.
        for service, endpoint in [('formwork', '/health'), ('kan', '/login')]:
            dc('exec', '-T', service, 'node', '-e', f"(async()=>{{for(let i=0;i<60;i++){{try{{if((await fetch('http://127.0.0.1:3000{endpoint}')).ok)return;}}catch{{}}await new Promise(r=>setTimeout(r,500));}}process.exit(1);}})()")
        dc('exec', '-T', 'caddy', 'sh', '-c', 'for i in $(seq 1 60); do nc -z 127.0.0.1 8080 && exit 0; sleep 0.5; done; exit 1')
        status, _, alias_headers = request('/boards', extra={'Host': 'devbox.tail7c6e1a.ts.net:14443'})
        assert status == 302 and alias_headers['Location'] == 'https://kan.localhost/boards'
        status, body, headers = request('/api/auth/get-session')
        assert status == 200, (status, body)
        assert json.loads(body)['user']['id'] == uid(2)
        assert 'Set-Cookie' not in headers and 'no-store' in headers['Cache-Control']
        bearer = {'Authorization': 'Bearer ' + credential['apiToken']}
        status, body, _ = request('/api/v1/users/me', 'none', extra={**bearer, 'X-Formwork-User': uid(3), 'X-Formwork-Groups': uid(6)})
        assert status == 200 and json.loads(body)['id'] == uid(2), (status, body)
        assert request('/api/internal/formwork-token', 'none', extra=bearer)[0] == 404
        assert request('/api/auth/get-session', 'none', extra=bearer)[0] == 302
        for token, expected in [(revoked['apiToken'], 401), (expired['apiToken'], 401), (denied['apiToken'], 403), (stale['apiToken'], 403), ('x' * 40, 401)]:
            assert request('/api/v1/workspaces', 'none', extra={'Authorization': 'Bearer ' + token})[0] == expected
        sql(f"UPDATE tools SET enabled=false WHERE id='{uid(7)}';")
        assert request('/api/v1/workspaces', 'none', extra=bearer)[0] == 403
        sql(f"UPDATE tools SET enabled=true WHERE id='{uid(7)}';")
        status, body, _ = request('/api/auth/get-session', 'user', extra={'X-Formwork-User': uid(2), 'X-Formwork-Tenant': uid(9)})
        assert status == 200 and json.loads(body)['user']['id'] == uid(3), (status, body)
        for kind, expected in [('none', 302), ('guest', 403), ('nonstaff', 403), ('other', 403), ('expired', 302), ('second-admin', 403)]:
            assert request('/api/auth/get-session', kind)[0] == expected, kind
        status, body, _ = request('/api/v1/workspaces')
        assert status == 200, (status, body)
        membership = json.loads(body)[0]
        assert membership['role'] == 'admin'
        workspace = membership['workspace']
        sql(f"INSERT INTO github_sync_settings(\"workspaceId\",\"userId\",repositories,enabled) SELECT id,'{uid(2)}','[\"ClockworkDigital/test\"]'::jsonb,true FROM workspace WHERE \"publicId\"='{workspace['publicId']}'; INSERT INTO integration(provider,\"userId\",\"accessToken\",\"expiresAt\",\"createdAt\") VALUES('github','{uid(2)}','test-only',now()+interval '1 day',now());", 'kan')
        sync_grant = scratch / 'sync-grant.json'
        sync_profile = scratch / 'sync-profile.json'
        sync_grant.write_text(json.dumps({'purpose':'formwork-kan-github-sync','tenantId':uid(1),'userId':uid(2),'groups':[uid(4),uid(5)],'accountType':'0','targetHost':'kan.localhost','workspacePublicId':workspace['publicId']}))
        run(['node','node_modules/vite-node/vite-node.mjs','deploy/formwork/issue-sync.ts',sync_grant,sync_profile],env=operator_env)
        delegated = json.loads(sync_profile.read_text())
        assert delegated['expiresAt'] is None
        sync_bearer = {'Authorization':'Bearer '+delegated['apiToken']}
        settings_path = '/api/v1/integrations/github/sync/settings?workspacePublicId='+workspace['publicId']
        assert request(settings_path,'none',extra=sync_bearer)[0] == 200
        assert request('/api/v1/workspaces','none',extra=sync_bearer)[0] == 403
        assert request('/api/v1/integrations/github/sync/settings?workspacePublicId=foreign12345','none',extra=sync_bearer)[0] == 403
        sql('UPDATE github_sync_settings SET enabled=false;', 'kan')
        assert request('/api/v1/users/me','none',extra=sync_bearer)[0] == 403
        assert request(settings_path,'none',extra=sync_bearer)[0] == 200
        sql('UPDATE github_sync_settings SET enabled=true;', 'kan')
        assert request('/api/v1/users/me','none',extra=sync_bearer)[0] == 200
        sql(f'UPDATE "apiKey" SET enabled=false WHERE id={int(delegated["keyId"])};', 'kan')
        assert request(settings_path,'none',extra=sync_bearer)[0] == 401
        sql(f'UPDATE "apiKey" SET enabled=true WHERE id={int(delegated["keyId"])};', 'kan')
        status, body, _ = request('/api/v1/workspaces', 'user')
        assert status == 200 and json.loads(body)[0]['role'] == 'admin'
        status, body, _ = request(f"/api/v1/workspaces/{workspace['publicId']}/boards", 'none', body={'name': 'GitHub: ClockworkDigital/test', 'lists': ['To do', 'Done'], 'labels': []}, extra=sync_bearer)
        assert status == 200, (status, body)
        board = json.loads(body)
        status, body, _ = request(f"/api/v1/boards/{board['publicId']}")
        assert status == 200, (status, body)
        details = json.loads(body)
        status, body, _ = request('/api/v1/cards', 'none', body={'title': 'Persisted verification card', 'description': '', 'listPublicId': details['lists'][0]['publicId'], 'labelPublicIds': [], 'memberPublicIds': [], 'position': 'end'}, extra=sync_bearer)
        assert status == 200, (status, body)
        card = json.loads(body)
        dc('restart', 'kan')
        dc('exec', '-T', 'kan', 'node', '-e', "(async()=>{for(let i=0;i<60;i++){try{if((await fetch('http://127.0.0.1:3000/login')).ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}process.exit(1);})()")
        status, body, _ = request(f"/api/v1/boards/{board['publicId']}", 'user')
        assert status == 200 and card['publicId'] in body and 'Persisted verification card' in body
        sql(f"INSERT INTO user_blocks(tenant_id,user_id,reason) VALUES('{uid(1)}','{uid(2)}','Verification');")
        assert request(settings_path,'none',extra=sync_bearer)[0] == 403
        assert request('/api/auth/get-session')[0] == 403
        assert request('/api/v1/workspaces', 'none', extra=bearer)[0] == 403
        assert request('/api/auth/get-session', 'user')[0] == 200
        sql(f"DELETE FROM user_blocks WHERE user_id='{uid(2)}'; UPDATE tool_groups SET group_id='{uid(6)}' WHERE tool_id='{uid(7)}';")
        assert request('/api/v1/workspaces', 'none', extra=bearer)[0] == 403
        assert request(settings_path,'none',extra=sync_bearer)[0] == 403
        sql(f"UPDATE tool_groups SET group_id='{uid(5)}' WHERE tool_id='{uid(7)}';")
        sql(f'''UPDATE workspace_members SET status='removed' WHERE "userId"='{uid(2)}';''', 'kan')
        assert request(f"/api/v1/boards/{board['publicId']}", 'none', extra=bearer)[0] in [403, 404]
        assert request(settings_path,'none',extra=sync_bearer)[0] == 403
        kan = json.loads(run(['docker', 'inspect', dc('ps', '-q', 'kan')]))[0]
        assert not kan['HostConfig']['PortBindings']
        assert set(kan['NetworkSettings']['Networks']) == {project + '_kan', project + '_kan_db'}
        dc('exec', '-T', 'formwork', 'node', '-e', "fetch('http://kan:3000/login',{signal:AbortSignal.timeout(2000)}).then(()=>process.exit(1)).catch(()=>process.exit(0))")
        dc('stop', 'formwork')
        assert request('/api/v1/workspaces', 'none', extra=bearer)[0] >= 500
        assert request(settings_path,'none',extra=sync_bearer)[0] >= 500
        print('PASS background sync scope, pause, revocation and current policy; browser and MCP identity, spoofing, key expiry/revocation, group/tool/membership denial, native board/card writes, restart persistence, current emergency blocks, policy outage and backend isolation.')
    except Exception:
        print(dc('logs', '--tail', '25', 'caddy', 'kan', 'formwork'))
        raise
    finally:
        dc('down', '-v', '--remove-orphans')
