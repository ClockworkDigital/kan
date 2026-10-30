#!/usr/bin/env python3
import json, os, subprocess, urllib.request, datetime, pathlib, fcntl, html
from urllib.error import HTTPError
from labels import github_labels, sync_labels, issue_label_ids, sync_card_labels, validate_label_ownership

ROOT = pathlib.Path(__file__).resolve().parents[3]
STATE = pathlib.Path.home()/'.local/share/formwork/kan-github-sync'
PROFILE = pathlib.Path.home()/'.config/formwork/kan/github-sync-credential.json'
CONFIG = pathlib.Path.home()/'.config/formwork/kan/github-sync.json'
WORKSPACE = 'workspace-set-at-start'

def error_fields(error):
    result = {'error': type(error).__name__}
    # HTTP errors may contain credentials in URLs, headers, reasons or response bodies.
    if isinstance(error, HTTPError):result['httpStatus'] = error.code
    return result

def reconcile(base, github, kan):
    outbound, inbound, conflicts = {}, {}, []
    for field in ('title', 'body', 'state'):
        g, k, b = github[field], kan[field], base[field]
        if g == k: continue
        if field == 'state':
            inbound[field] = g
            continue
        if g == b: outbound[field] = k
        elif k == b: inbound[field] = g
        else: conflicts.append(field)
    return outbound, inbound, conflicts

def main():
    global WORKSPACE
    config = json.loads(CONFIG.read_text())
    WORKSPACE = config['workspacePublicId']
    os.umask(0o077)
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = open(STATE/'lock', 'w'); fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    # Consume only after locking and before reads; later deliveries request another run.
    (STATE/'webhook.pending').unlink(missing_ok=True)
    profile = json.loads(PROFILE.read_text())
    assert PROFILE.stat().st_mode & 0o077 == 0
    if profile.get('expiresAt'):
        assert datetime.datetime.fromisoformat(profile['expiresAt'].replace('Z','+00:00')) > datetime.datetime.now(datetime.timezone.utc), 'Sync delegation expired'
    assert profile['baseUrl'] == config['baseUrl'] and profile['baseUrl'].startswith('https://')
    def kan(path, body=None):
        method = 'GET' if body is None else ('POST' if path.endswith('/boards') or path in ['/cards', '/labels', '/integrations/github/sync'] else 'PUT')
        req = urllib.request.Request(profile['baseUrl']+'/api/v1'+path, data=json.dumps(body).encode() if body is not None else None, headers={'Authorization':'Bearer '+profile['apiToken'],'Content-Type':'application/json'},method=method)
        # Never forward the bearer credential across a redirect.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args): return None
        with urllib.request.build_opener(NoRedirect).open(req,timeout=30) as response: return json.load(response)
    def gh(path, body=None, pages=False):
        result=[]
        for page in range(1,1001):
            payload={'workspacePublicId':WORKSPACE,'path':path,'page':page}
            if body is not None:payload['changes']=body
            batch=kan('/integrations/github/sync',payload)
            if not pages:return batch
            assert isinstance(batch,list)
            result.extend(batch)
            if len(batch)<100:return result
        raise RuntimeError('GitHub pagination limit reached')
    def authorize():
        me=kan('/users/me'); assert me['id']==config['userId']
        permissions=kan(f'/workspaces/{WORKSPACE}/permissions/me')['permissions']
        assert all(p in permissions for p in ['board:create','card:create','card:edit'])
    settings_path='/integrations/github/sync/settings?workspacePublicId='+WORKSPACE
    settings=kan(settings_path)
    if not settings['enabled']:
        print('GitHub sync paused');lock.close();return
    selected=set(settings['repositories'])
    authorize()
    file=STATE/'state.json'
    state=json.loads(file.read_text()) if file.exists() else {'boards':{},'issues':{}}
    state.setdefault('labels', {})
    validate_label_ownership(state['boards'], state['labels'])
    def save():
        tmp=STATE/'state.tmp';tmp.write_text(json.dumps(state));tmp.replace(file)
    boards=kan(f'/workspaces/{WORKSPACE}/boards')
    report={'created':0,'updatedGitHub':0,'updatedKan':0,'conflicts':[], 'errors':[]}
    repos=gh('orgs/ClockworkDigital/repos?per_page=100',pages=True)
    if not selected.issubset({repo['full_name'] for repo in repos}):
        raise RuntimeError('Saved GitHub PAT cannot access every previously synced repository')
    for repo in repos:
        if repo['full_name'] not in selected or repo['archived'] or not repo['has_issues']: continue
        name=repo['full_name'];assert name.startswith('ClockworkDigital/')
        rid=str(repo['id'])
        issues=gh(f'repos/{name}/issues?state=open&per_page=100',pages=True)
        issues=[i for i in issues if 'pull_request' not in i]
        tracked=[v for v in state['issues'].values() if v['repoId']==rid]
        present={str(i['id']) for i in issues}
        for old in tracked:
            if old['id'] not in present:
                try: issues.append(gh(f'repos/{name}/issues/{old["number"]}'))
                except Exception as e: report['errors'].append({'repository':name,'number':old['number'],'operation':'issue-read',**error_fields(e)});continue
        if not issues and rid not in state['boards']: continue
        if rid not in state['boards']:
            title='GitHub: '+name
            matches=[b for b in boards if b['name']==title];assert len(matches)<=1
            board=matches[0] if matches else kan(f'/workspaces/{WORKSPACE}/boards',{'name':title,'lists':['Open','In progress','Closed'],'labels':[]})
            state['boards'][rid]=board['publicId'];save()
        board=kan('/boards/'+state['boards'][rid])
        assert board['workspace']['publicId']==WORKSPACE and board['visibility']=='private'
        try:
            source=github_labels(gh(f'repos/{name}/labels?per_page=100',pages=True))
            active_labels,managed_labels=sync_labels(kan,board,source,state['labels'].setdefault(rid,{}),save)
        except Exception as e:
            error={'repository':name,'operation':'labels',**error_fields(e)}
            if isinstance(e,(RuntimeError,ValueError)):error['detail']=str(e)
            report['errors'].append(error)
            continue
        lists={l['name']:l['publicId'] for l in board['lists']}
        assert 'Open' in lists and 'Closed' in lists
        cards=[c for l in board['lists'] for c in l['cards']]
        for issue in issues:
            iid=str(issue['id']);url=issue['html_url'];link={'githubRepository':name.lower(),'githubIssueNumber':issue['number']}
            if 'pull_request' in issue or not url.startswith('https://github.com/ClockworkDigital/'):continue
            marker=f'<p><a href="{url}">GitHub issue #{issue["number"]}</a></p><hr>'
            # Keep Markdown source in a code block so edits round-trip without lossy HTML conversion.
            def render(body):return marker+'<pre><code>'+html.escape(body or '')+'</code></pre>'
            def fields(card):
                from html.parser import HTMLParser
                class Text(HTMLParser):
                    def __init__(self):super().__init__();self.parts=[]
                    def handle_data(self,data):self.parts.append(data)
                    def handle_starttag(self,tag,attrs):
                        if tag=='br':self.parts.append('\n')
                    def handle_endtag(self,tag):
                        if tag in ['p','div','li']:self.parts.append('\n')
                description=card['description'] or ''
                import re
                description=re.sub(r'^<p\b[^>]*>.*?</p>\s*<hr\b[^>]*>', '',description,count=1,flags=re.S) if url in description.split('</p>',1)[0] else description
                parser=Text();parser.feed(description)
                return {'title':card['title'],'body':''.join(parser.parts).rstrip('\n'),'state':'closed' if card['list']['publicId']==lists['Closed'] else 'open'}
            g={'title':issue['title'],'body':(issue['body'] or '').rstrip('\n'),'state':issue['state']}
            try:
                desired_labels=issue_label_ids(issue,active_labels)
                old=state['issues'].get(iid)
                if not old:
                    matches=[c for c in cards if (c.get('githubRepository'),c.get('githubIssueNumber'))==tuple(link.values())];assert len(matches)<=1
                    if len(render(g['body']))>10000:raise RuntimeError('Description exceeds Kan limit')
                    card=matches[0] if matches else kan('/cards',{'title':g['title'],'description':render(g['body']),'listPublicId':lists['Closed' if g['state']=='closed' else 'Open'],'labelPublicIds':sorted(desired_labels),'memberPublicIds':[],'position':'end',**link})
                    old={'id':iid,'repoId':rid,'number':issue['number'],'card':card['publicId'],'base':g}
                    state['issues'][iid]=old;save();report['created']+=not bool(matches)
                card=kan('/cards/'+old['card'])
                assert card['list']['board']['publicId']==board['publicId']
                # The card's issue link is identity for factory actions: attach it once, never overwrite it.
                current={key:card.get(key) for key in link}
                if current=={key:None for key in link}:kan('/cards/'+old['card'],link)
                elif current!=link:raise RuntimeError('Card is linked to another issue')
                k=fields(card)
                outbound,inbound,conflicts=reconcile(old['base'],g,k)
                if conflicts:report['conflicts'].append({'issue':url,'fields':conflicts})
                current_labels={label['publicId'] for label in card['labels']}
                labels_changed=bool((desired_labels-current_labels) | ((current_labels & managed_labels)-desired_labels))
                if outbound or inbound or labels_changed:
                    fresh=gh(f'repos/{name}/issues/{issue["number"]}')
                    freshcard=kan('/cards/'+old['card'])
                    if fresh['updated_at']!=issue['updated_at'] or fields(freshcard)!=k:continue
                    if issue_label_ids(fresh,active_labels)!=desired_labels:continue
                if outbound:
                    assert repo['permissions']['push'];authorize()
                    gh(f'repos/{name}/issues/{issue["number"]}',outbound);g.update(outbound);report['updatedGitHub']+=1
                if inbound:
                    patch={}
                    if 'title' in inbound:patch['title']=inbound['title']
                    if 'body' in inbound:patch['description']=render(inbound['body'])
                    if 'state' in inbound:patch['listPublicId']=lists['Closed' if inbound['state']=='closed' else 'Open']
                    kan('/cards/'+old['card'],patch);k.update(inbound);report['updatedKan']+=1
                if labels_changed and sync_card_labels(kan,card,board['publicId'],desired_labels,managed_labels):
                    if not inbound:report['updatedKan']+=1
                for field in g:
                    if g[field]==k[field]:old['base'][field]=g[field]
                save()
            except Exception as e:
                report['errors'].append({'issue':url,**error_fields(e)})
    report['checkedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    (STATE/'status.json').write_text(json.dumps(report,indent=2))
    kan('/integrations/github/sync/status',{'workspacePublicId':WORKSPACE,'status':{**{key:report[key] for key in ['checkedAt','created','updatedGitHub','updatedKan']},'conflicts':len(report['conflicts']),'errors':len(report['errors'])}})
    print(json.dumps(report))
    lock.close()
    if report['errors'] or report['conflicts']:raise SystemExit(1)

if __name__=='__main__':
    try:main()
    except Exception as error:
        failure={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stopped':True,**error_fields(error)}
        if STATE.exists():(STATE/'status.json').write_text(json.dumps(failure))
        print('GitHub sync stopped: '+json.dumps(error_fields(error)),file=__import__('sys').stderr)
        raise SystemExit(1)
