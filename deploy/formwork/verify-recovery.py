#!/usr/bin/env python3
"""Export disposable Kan data through Formwork's coordinated exporter, then restore it into a new project."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time

DEPLOY = Path(__file__).resolve().parent
ROOT = DEPLOY.parents[1]
PLATFORM = Path(os.environ.get('FORMWORK_ROOT', ROOT.parent / 'formwork')).resolve()
os.chdir(ROOT)

def run(args, text=None, env=None, check=True):
    result = subprocess.run(list(map(str, args)), input=text, text=True, capture_output=True, env=env)
    assert not check or result.returncode == 0, result.stderr + result.stdout
    return result if not check else result.stdout.strip()

def uid(number):
    return f'10000000-0000-4000-8000-{number:012d}'

image = os.environ.get('KAN_TEST_IMAGE', 'kan:formwork-poc')
platform_image = os.environ.get('FORMWORK_IMAGE') or run(['docker', 'inspect', 'formwork-auth0-demo-formwork-1', '--format', '{{.Image}}'])
operations_image = os.environ.get('FORMWORK_OPERATIONS_IMAGE', 'formwork-operations:validation')
tag = 'kan-recovery-' + secrets.token_hex(4)
platform, source, restored = tag, tag + '-source', tag + '-restored'
gateways = {source: tag + '-gateway-source', restored: tag + '-gateway-restored'}
# Throwaway credentials. None of them may appear in exporter output or the bundle.
credentials = {name: secrets.token_hex(24) for name in ['platform', 'admin', 'runtime', 'auth', 'api', 'pat']}
octet = secrets.randbelow(240)
subnets = iter(f'10.247.{octet}.{index * 16}/28' for index in range(16))
checks = 0

def check(label, condition):
    global checks
    assert condition, label
    checks += 1
    print('PASS ' + label, flush=True)

with tempfile.TemporaryDirectory(prefix=tag + '-') as folder:
    scratch = Path(folder)
    (scratch / 'Caddyfile').write_text('{\n  auto_https off\n}\nimport /etc/caddy/gateway.caddy\nhttp://:8080 {\n  route {\n    import /etc/caddy/kan.caddy\n    respond 404\n  }\n}\n')
    platform_env = {
        'ENTRA_TENANT_ID': uid(1), 'ENTRA_STAFF_GROUP_ID': uid(4),
        'FORMWORK_HOST': 'formwork.localhost', 'TOOL_DOMAIN': 'localhost',
        'DATABASE_URL': f'postgresql://formwork_owner:{credentials["platform"]}@postgres:5432/formwork',
        'GATEWAY_SHARED_SECRET': credentials['platform'],
    }
    platform_compose = {
        'services': {
            'postgres': {
                'image': 'postgres:18.6-bookworm', 'environment': {
                    'POSTGRES_USER': 'formwork_owner', 'POSTGRES_PASSWORD': credentials['platform'], 'POSTGRES_DB': 'formwork'},
                'networks': ['platform_db'],
                'healthcheck': {'test': ['CMD-SHELL', 'pg_isready -U formwork_owner -d formwork'], 'interval': '2s', 'retries': 30},
            },
            'operations': {'image': operations_image, 'environment': platform_env, 'networks': ['platform_db']},
            'formwork': {'image': platform_image, 'environment': platform_env, 'networks': ['auth', 'platform_db']},
            'oauth2-proxy': {
                'image': 'node:24.22.1-bookworm-slim', 'command': ['node', '/identity.mjs'],
                'volumes': [f'{PLATFORM}/deploy/prototype/identity.mjs:/identity.mjs:ro'], 'networks': ['auth'],
            },
            'caddy': {
                'image': 'caddy:2.11.7-alpine', 'ports': ['127.0.0.1::8080'],
                'environment': {'KAN_HOST': 'kan.localhost', 'FORMWORK_HOST': 'formwork.localhost', 'GATEWAY_SHARED_SECRET': credentials['platform']},
                'volumes': [f'{scratch}/Caddyfile:/etc/caddy/Caddyfile:ro',
                            f'{PLATFORM}/deploy/gateway.caddy:/etc/caddy/gateway.caddy:ro',
                            f'{PLATFORM}/deploy/auth0/kan.caddy:/etc/caddy/kan.caddy:ro'],
                'networks': ['auth', 'edge', 'gateway'],
            },
        },
        'networks': {name: {'internal': name != 'edge', 'ipam': {'config': [{'subnet': next(subnets)}]}} for name in ['auth', 'platform_db', 'edge']},
    }
    platform_compose['networks']['gateway'] = {'external': True, 'name': gateways[source]}
    (scratch / 'platform.json').write_text(json.dumps(platform_compose))
    (scratch / 'platform.env').write_text('')
    platform_cli = {**os.environ, 'COMPOSE_FILE': str(scratch / 'platform.json'), 'COMPOSE_PROJECT_NAME': platform}
    def pc(*args): return run(['docker', 'compose', '--env-file', scratch / 'platform.env', *args], env=platform_cli)
    def platform_sql(statement):
        return run(['docker', 'compose', '--env-file', scratch / 'platform.env', 'exec', '-T', 'postgres', 'psql', '-X',
                    '-U', 'formwork_owner', '-d', 'formwork', '-At', '-v', 'ON_ERROR_STOP=1'], statement, platform_cli)

    # Kan projects use the real Compose file; the overlay only keeps them offline on small private ranges.
    kan_files = {}
    def kan_project(name, database):
        secret_dir = scratch / (name + '-secrets')
        secret_dir.mkdir(mode=0o700)
        for filename, value in {'database-admin': credentials['admin'], 'auth-secret': credentials['auth'], 'admin-api-key': credentials['api'],
                                'runtime-database': f'postgresql://kan_runtime:{credentials["runtime"]}@postgres:5432/{database}'}.items():
            (secret_dir / filename).write_text(value)
            # The postgres entrypoint reads its file after dropping to its own UID.
            (secret_dir / filename).chmod(0o644)
        overlay = scratch / (name + '-overlay.yaml')
        overlay.write_text(f'networks:\n  egress:\n    internal: true\n    ipam: !override\n      config: [{{subnet: {next(subnets)}}}]\n'
                           f'  database:\n    ipam:\n      config: [{{subnet: {next(subnets)}}}]\n')
        environment = scratch / (name + '.env')
        environment.write_text(f'KAN_IMAGE={image}\nFORMWORK_TENANT_ID={uid(1)}\nKAN_URL=https://kan.localhost\n'
                               f'FORMWORK_URL=https://formwork.localhost\nKAN_SECRET_DIR={secret_dir}\nKAN_GATEWAY_NETWORK={gateways[name]}\n')
        kan_files[name] = (environment, [DEPLOY / 'compose.yaml', overlay])
    def kan_env(name):
        return {**os.environ, 'COMPOSE_PROJECT_NAME': name, 'COMPOSE_FILE': ':'.join(map(str, kan_files[name][1]))}
    def kc(name, *args, text=None, check=True):
        return run(['docker', 'compose', '--env-file', kan_files[name][0], *args], text, kan_env(name), check)
    def kan_sql(name, statement, database='kan', check=True):
        return kc(name, 'exec', '-T', 'postgres', 'psql', '-X', '-U', 'kan_owner', '-d', database, '-At', '-v', 'ON_ERROR_STOP=1', '-c', statement, check=check)
    def operator_env(name, database='kan'):
        container = json.loads(run(['docker', 'inspect', kc(name, 'ps', '-q', 'postgres')]))[0]
        address = container['NetworkSettings']['Networks'][name + '_database']['IPAddress']
        return {**os.environ, 'POSTGRES_URL': f'postgresql://kan_owner:{credentials["admin"]}@{address}:5432/{database}',
                'BETTER_AUTH_SECRET': credentials['auth'], 'NEXT_PUBLIC_BASE_URL': 'https://kan.localhost', 'FORMWORK_TENANT_ID': uid(1)}
    # Kan enables row-level security without policies, so a non-owner runtime role must bypass it.
    runtime_role = f"CREATE ROLE kan_runtime LOGIN NOSUPERUSER BYPASSRLS PASSWORD '{credentials['runtime']}';"
    runtime_grants = ('GRANT USAGE ON SCHEMA public TO kan_runtime; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kan_runtime; '
                      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kan_runtime;')
    def create_runtime_role(name):
        # Operator step from protected credentials; the password is sent on stdin, not as an argument.
        kc(name, 'exec', '-T', 'postgres', 'psql', '-X', '-q', '-U', 'kan_owner', '-d', 'kan', '-v', 'ON_ERROR_STOP=1', text=runtime_role)
    def table_digest(name, database='kan'):
        tables = kan_sql(name, "SELECT tablename FROM pg_tables WHERE schemaname IN ('public','drizzle') ORDER BY 1;", database).split()
        rows = {table: kan_sql(name, f'SELECT count(*) || \':\' || md5(coalesce(string_agg(t::text, \'|\' ORDER BY t::text), \'\')) FROM "{table}" t;', database)
                for table in tables if table != '__drizzle_migrations'}
        rows['migrations'] = kan_sql(name, 'SELECT md5(string_agg(hash, \',\' ORDER BY id)) FROM drizzle.__drizzle_migrations;', database)
        rows['grants'] = kan_sql(name, "SELECT md5(string_agg(table_name || privilege_type, ',' ORDER BY table_name, privilege_type)) FROM information_schema.role_table_grants WHERE grantee='kan_runtime';", database)
        return rows
    def containers(name):
        return {service: json.loads(run(['docker', 'inspect', kc(name, 'ps', '-aq', service)]))[0] for service in ['web', 'postgres']}
    def fingerprint(name):
        return {service: (item['Id'], item['Image'], item['State']['Running'], item['State']['StartedAt'], item['RestartCount'])
                for service, item in containers(name).items()}

    def request(path, identity='admin', body=None, extra=None):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=15)
        headers = {'Host': 'kan.localhost', 'X-Prototype-Identity': identity, **(extra or {})}
        if body is not None: headers['Content-Type'] = 'application/json'
        connection.request('GET' if body is None else 'POST', path, json.dumps(body) if body is not None else None, headers)
        response = connection.getresponse()
        result = response.status, response.read().decode()
        connection.close()
        return result
    def wait_kan(name):
        kc(name, 'exec', '-T', 'web', 'node', '-e', "(async()=>{for(let i=0;i<90;i++){try{if((await fetch('http://127.0.0.1:3000/login')).ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}process.exit(1);})()")
    def switch_gateway(old, new):
        global port
        caddy = pc('ps', '-q', 'caddy')
        run(['docker', 'network', 'disconnect', gateways[old], caddy])
        run(['docker', 'network', 'connect', gateways[new], caddy])
        # Drop pooled upstream connections to the previous Kan.
        pc('restart', 'caddy')
        port = int(pc('port', 'caddy', '8080').rsplit(':', 1)[1])
        pc('exec', '-T', 'caddy', 'sh', '-c', 'for i in $(seq 1 60); do nc -z 127.0.0.1 8080 && exit 0; sleep 0.5; done; exit 1')
    def export(output, projects, path=None):
        registry = scratch / ('registry-' + output.name + '.json')
        registry.write_text(json.dumps(projects))
        environment = {**platform_cli, 'PATH': f'{path}:{os.environ["PATH"]}' if path else os.environ['PATH']}
        return run(['node', PLATFORM / 'scripts/export-recovery.mjs', scratch / 'platform.env', registry, scratch / 'encrypted', output], env=environment, check=False)
    def registry_entry(name):
        return {'name': name, 'directory': str(DEPLOY), 'environmentFile': str(kan_files[name][0]),
                'composeFiles': list(map(str, kan_files[name][1])), 'services': [{'name': 'web'}, {'name': 'postgres'}]}
    def leaks(*texts):
        return [name for name, value in credentials.items() if any(value.encode() in text for text in texts)]

    created_networks = []
    try:
        for name in [source, restored]:
            run(['docker', 'network', 'create', '--internal', '--subnet', next(subnets), gateways[name]])
            created_networks.append(gateways[name])
        kan_project(source, 'kan')
        kan_project(restored, 'kan_restored')
        pc('up', '-d', '--wait', 'postgres')
        pc('run', '--rm', 'operations')
        platform_sql(f"INSERT INTO tools(id,slug,name,description,hostname,enabled,visible) VALUES('{uid(7)}','kan','Kan','Department','kan.localhost',true,true); INSERT INTO tool_groups(tool_id,group_id) VALUES('{uid(7)}','{uid(5)}');")
        (scratch / 'encrypted').mkdir(mode=0o700)
        (scratch / 'encrypted' / 'selection.json').write_text('{"version":null,"image":null}')

        kc(source, 'up', '-d', '--wait', 'postgres')
        operator = operator_env(source)
        run(['node', '-e', "const{Pool}=require('pg');const{drizzle}=require('drizzle-orm/node-postgres');const{migrate}=require('drizzle-orm/node-postgres/migrator');const p=new Pool({connectionString:process.env.POSTGRES_URL});migrate(drizzle(p),{migrationsFolder:'packages/db/migrations'}).finally(()=>p.end());"], env=operator)
        create_runtime_role(source)
        kan_sql(source, runtime_grants)
        approved = scratch / 'approved.json'
        approved.write_text(json.dumps([{'id': uid(n), 'name': f'Test admin {n}', 'email': f'admin{n}@example.test'} for n in [2, 3]]))
        run(['node', 'node_modules/vite-node/vite-node.mjs', DEPLOY / 'provision.ts', approved], env=operator)
        grant, profile = scratch / 'grant.json', scratch / 'mcp.json'
        grant.write_text(json.dumps({'purpose': 'formwork-kan-mcp', 'tenantId': uid(1), 'userId': uid(2), 'groups': [uid(4), uid(5)],
                                     'accountType': '0', 'issuedAt': int(time.time()), 'targetHost': 'kan.localhost'}))
        run(['node', 'node_modules/vite-node/vite-node.mjs', DEPLOY / 'issue-mcp.ts', grant, profile], env=operator)
        bearer = {'Authorization': 'Bearer ' + json.loads(profile.read_text())['apiToken']}
        credentials['mcp'] = bearer['Authorization'][7:]

        pc('up', '-d', 'formwork', 'oauth2-proxy', 'caddy')
        kc(source, 'up', '-d', 'web')
        port = int(pc('port', 'caddy', '8080').rsplit(':', 1)[1])
        pc('exec', '-T', 'formwork', 'node', '-e', "(async()=>{for(let i=0;i<60;i++){try{if((await fetch('http://127.0.0.1:3000/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}process.exit(1);})()")
        wait_kan(source)

        # Representative data: board, lists, label, cards, comment, member assignment and saved sync settings.
        status, body = request('/api/v1/workspaces')
        assert status == 200, (status, body)
        workspace = json.loads(body)[0]['workspace']['publicId']
        status, body = request(f'/api/v1/workspaces/{workspace}/boards', body={'name': 'Recovery board', 'lists': ['To do', 'Done'], 'labels': ['Recovery label']})
        assert status == 200, (status, body)
        board = json.loads(body)['publicId']
        details = json.loads(request(f'/api/v1/boards/{board}')[1])
        member = kan_sql(source, f'''SELECT "publicId" FROM workspace_members WHERE "userId"='{uid(2)}';''')
        cards = []
        for title, index in [('Restorable card one', 0), ('Restorable card two', 1)]:
            status, body = request('/api/v1/cards', body={'title': title, 'description': 'Recovery drill', 'listPublicId': details['lists'][index]['publicId'],
                                                          'labelPublicIds': [details['labels'][0]['publicId']], 'memberPublicIds': [member], 'position': 'end'})
            assert status == 200, (status, body)
            cards.append(json.loads(body)['publicId'])
        status, body = request(f'/api/v1/cards/{cards[0]}/comments', body={'comment': 'Comment preserved by recovery'})
        assert status == 200, (status, body)
        encrypted_pat = run(['node', '-e', "const c=require('crypto');const k=c.createHash('sha256').update(process.env.BETTER_AUTH_SECRET).digest();const i=c.randomBytes(12);const x=c.createCipheriv('aes-256-gcm',k,i);const e=Buffer.concat([x.update(process.env.PAT,'utf8'),x.final()]);console.log(Buffer.concat([i,x.getAuthTag(),e]).toString('base64url'))"],
                            env={**os.environ, 'BETTER_AUTH_SECRET': credentials['auth'], 'PAT': credentials['pat']})
        kan_sql(source, f'''INSERT INTO github_sync_settings("workspaceId","userId",repositories,enabled) SELECT id,'{uid(2)}','["ClockworkDigital/recovery"]'::jsonb,true FROM workspace WHERE "publicId"='{workspace}';
            INSERT INTO integration(provider,"userId","accessToken","expiresAt","createdAt") VALUES('github','{uid(2)}','{encrypted_pat}',now()+interval '1 day',now());
            UPDATE workspace_members SET status='removed' WHERE "userId"='{uid(3)}';''')
        check('removed member is natively denied in the source', request(f'/api/v1/boards/{board}', 'user')[0] in [403, 404])
        before = table_digest(source)
        state = fingerprint(source)

        # A tool failure after the Kan export must leave no bundle and no stopped Kan.
        broken = scratch / 'broken-tool'
        (broken / 'scripts').mkdir(parents=True)
        (broken / 'scripts/backup.sh').write_text('#!/bin/sh\nexit 17\n')
        result = export(scratch / 'later-failure', [registry_entry(source), {**registry_entry(source), 'name': 'broken', 'directory': str(broken)}])
        check('later tool failure removes the whole bundle', result.returncode == 1 and not (scratch / 'later-failure').exists())
        check('later tool failure leaves source containers unchanged', fingerprint(source) == state)
        shim = scratch / 'bin'
        shim.mkdir()
        (shim / 'docker').write_text('#!/bin/sh\ncase "$*" in *"exec pg_dump"*) printf PGDMP-partial; exit 1;; esac\nexec /usr/bin/docker "$@"\n')
        (shim / 'docker').chmod(0o700)
        result = export(scratch / 'dump-failure', [registry_entry(source)], shim)
        check('Kan dump failure removes the whole bundle', result.returncode == 1 and not (scratch / 'dump-failure').exists())
        check('Kan dump failure leaves source containers and data unchanged', fingerprint(source) == state and table_digest(source) == before)
        missing = run(['bash', DEPLOY / 'scripts/backup.sh', kan_files[source][0], scratch / 'missing-project'], env={**kan_env(source), 'COMPOSE_PROJECT_NAME': tag + '-absent'}, check=False)
        check('backup refuses a project without running containers', missing.returncode == 1 and not (scratch / 'missing-project').exists())

        bundle = scratch / 'bundle'
        result = export(bundle, [registry_entry(source)])
        check('coordinated export succeeds', result.returncode == 0)
        exported = bundle / 'tools' / source
        manifest = json.loads((bundle / 'manifest.json').read_text())
        tool_manifest = json.loads((exported / 'manifest.json').read_text())
        dump = (exported / 'database.dump').read_bytes()
        check('bundle manifest records the Kan project', manifest['projects'] == [source] and tool_manifest['tool'] == 'kan')
        check('Kan export records its image and checksum', tool_manifest['image'] == state['web'][1] and dump.startswith(b'PGDMP')
              and hashlib.sha256(dump).hexdigest() == tool_manifest['sha256']['database.dump'])
        check('Kan export is private', (exported.stat().st_mode & 0o777) == 0o700 and ((exported / 'database.dump').stat().st_mode & 0o777) == 0o600)
        files = [path.read_bytes() for path in bundle.rglob('*') if path.is_file()]
        check('no plaintext credential appears in output or bundle', not leaks(result.stdout.encode(), result.stderr.encode(), *files))
        check('export leaves source containers and data unchanged', fingerprint(source) == state and table_digest(source) == before)

        # Restore refusals: existing names, tampering and a missing runtime role never leave a partial database.
        def restore(name, database, backup=exported):
            return run(['bash', DEPLOY / 'scripts/restore.sh', kan_files[name][0], backup, database], env=kan_env(name), check=False)
        result = restore(source, 'kan')
        check('restore refuses the live source database', result.returncode != 0 and table_digest(source) == before and fingerprint(source) == state)
        result = restore(source, 'Kan;drop')
        check('restore refuses an invalid database name', result.returncode == 2)
        tampered = scratch / 'tampered'
        tampered.mkdir()
        (tampered / 'manifest.json').write_text((exported / 'manifest.json').read_text())
        (tampered / 'database.dump').write_bytes(dump[:-1] + bytes([dump[-1] ^ 1]))
        kc(restored, 'up', '-d', '--wait', 'postgres')
        databases = lambda: kan_sql(restored, 'SELECT datname FROM pg_database ORDER BY 1;').split()
        result = restore(restored, 'kan_restored', tampered)
        check('restore rejects a tampered dump before creating a database', result.returncode != 0 and 'kan_restored' not in databases())
        result = restore(restored, 'kan_restored')
        check('restore without the recovered runtime role fails and drops its new database', result.returncode != 0 and 'kan_restored' not in databases())
        create_runtime_role(restored)
        result = restore(restored, 'kan_restored')
        check('restore into a new project and database succeeds', result.returncode == 0)
        result = restore(restored, 'kan_restored')
        check('restore refuses to reuse its own restored database', result.returncode != 0)
        check('restored tables, migrations and runtime grants match the source', table_digest(restored, 'kan_restored') == before)
        stored = kan_sql(restored, f'''SELECT "accessToken" FROM integration WHERE "userId"='{uid(2)}';''', 'kan_restored')
        decrypt = "const c=require('crypto');const b=Buffer.from(process.env.TOKEN,'base64url');const d=c.createDecipheriv('aes-256-gcm',c.createHash('sha256').update(process.env.BETTER_AUTH_SECRET).digest(),b.subarray(0,12));d.setAuthTag(b.subarray(12,28));process.stdout.write(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString())"
        check('saved GitHub token decrypts only with the recovered auth secret',
              run(['node', '-e', decrypt], env={**os.environ, 'TOKEN': stored, 'BETTER_AUTH_SECRET': credentials['auth']}) == credentials['pat']
              and run(['node', '-e', decrypt], env={**os.environ, 'TOKEN': stored, 'BETTER_AUTH_SECRET': 'wrong'}, check=False).returncode != 0)

        kc(restored, 'up', '-d', 'web')
        wait_kan(restored)
        switch_gateway(source, restored)
        status, body = request('/api/v1/workspaces')
        memberships = json.loads(body)
        check('restored admin keeps the workspace and admin role', status == 200 and memberships[0]['workspace']['publicId'] == workspace and memberships[0]['role'] == 'admin')
        status, body = request(f'/api/v1/boards/{board}')
        restored_board = json.loads(body)
        restored_cards = [card for item in restored_board['lists'] for card in item['cards']]
        check('restored board keeps lists, labels and cards', status == 200 and [item['name'] for item in restored_board['lists']] == ['To do', 'Done']
              and restored_board['labels'][0]['name'] == 'Recovery label' and sorted(card['publicId'] for card in restored_cards) == sorted(cards))
        check('restored cards keep labels and member assignments', all(card['labels'] and card['members'] for card in restored_cards))
        status, body = request(f'/api/v1/cards/{cards[0]}')
        check('restored card keeps its comment', status == 200 and 'Comment preserved by recovery' in body)
        check('removed member stays natively denied after restore', request(f'/api/v1/boards/{board}', 'user')[0] in [403, 404])
        status, body = request('/api/v1/users/me', 'none', extra={**bearer, 'X-Formwork-User': uid(3)})
        check('restored MCP credential works through the gateway without spoofing', status == 200 and json.loads(body)['id'] == uid(2))
        check('gateway still denies unsigned, guest and non-staff callers',
              [request('/api/v1/workspaces', kind)[0] for kind in ['none', 'guest', 'nonstaff']] == [302, 403, 403])
        platform_sql(f"INSERT INTO user_blocks(tenant_id,user_id,reason) VALUES('{uid(1)}','{uid(2)}','Recovery verification');")
        check('current emergency block applies to restored browser and MCP access',
              request('/api/v1/workspaces')[0] == 403 and request('/api/v1/workspaces', 'none', extra=bearer)[0] == 403)
        platform_sql(f"DELETE FROM user_blocks WHERE user_id='{uid(2)}'; UPDATE tools SET enabled=false WHERE id='{uid(7)}';")
        check('disabled tool denies restored access', request('/api/v1/workspaces')[0] == 403)
        platform_sql(f"UPDATE tools SET enabled=true WHERE id='{uid(7)}';")

        switch_gateway(restored, source)
        check('source project is still running unchanged with its data', fingerprint(source) == state and table_digest(source) == before
              and request(f'/api/v1/boards/{board}')[0] == 200)
        print(f'Kan recovery drill passed {checks} checks.')
    except Exception:
        for name in [source, restored]:
            print(kc(name, 'logs', '--tail', '20', check=False).stdout)
        raise
    finally:
        for name in [restored, source]:
            if name in kan_files:
                kc(name, 'down', '-v', '--remove-orphans', '--timeout', '2', check=False)
        pc('down', '-v', '--remove-orphans', '--timeout', '2')
        for network in created_networks:
            run(['docker', 'network', 'rm', network], check=False)
