import unittest
from sync import reconcile
class SyncTests(unittest.TestCase):
 def test_directions_and_conflict(self):
  base={'title':'old','body':'body','state':'open'}
  g={**base,'title':'github'};k={**base,'body':'kan'}
  self.assertEqual(reconcile(base,g,k),({'body':'kan'},{'title':'github'},[]))
  self.assertEqual(reconcile(base,g,{**base,'title':'kan'}),({},{},['title']))
 def test_repeat_and_close(self):
  base={'title':'t','body':'b','state':'open'}
  self.assertEqual(reconcile(base,base,base),({},{},[]))
  self.assertEqual(reconcile(base,base,{**base,'state':'closed'}),({},{'state':'open'},[]))
  self.assertEqual(reconcile(base,{**base,'state':'closed'},base),({},{'state':'closed'},[]))
if __name__=='__main__':unittest.main()

class WorkerTests(unittest.TestCase):
 def test_initial_label_import(self):
  self.test_import_repeat_both_directions_and_conflict(initial_labels=True)

 def test_import_repeat_both_directions_and_conflict(self,initial_labels=False):
  import sync, tempfile, pathlib, json, io, copy
  from unittest.mock import patch
  from types import SimpleNamespace
  issue={'id':1,'number':1,'title':'Original','body':'Body\n\n- Item','state':'open','updated_at':'one','html_url':'https://github.com/ClockworkDigital/test/issues/1','labels':[]}
  repo={'id':2,'full_name':'ClockworkDigital/test','archived':False,'has_issues':True,'permissions':{'push':True}}
  kan_labels={};repo_labels=([{'id':9,'name':'initial','color':'123456'}] if initial_labels else []);label_writes=[]
  if initial_labels:
   repo_labels.extend({'id':100+i,'name':f'label-{i}','color':'abcdef'} for i in range(100))
  issue['labels']=repo_labels[:1]
  cards={};writes=[];selected=['ClockworkDigital/test'];enabled=True
  def github(args,**kw):
   path=args[2]
   if path.startswith('orgs/'):result=[[repo]]
   elif '/labels?' in path:result=[repo_labels]
   elif kw.get('input'):
    self.assertTrue(set(json.loads(kw['input'])) <= {'title','body'})
    issue.update(json.loads(kw['input']));writes.append('github');result=issue
   elif '?' in path:result=[[issue] if issue['state']=='open' else []]
   else:result=issue
   return SimpleNamespace(returncode=0,stdout=json.dumps(result))
  def api(req,**kw):
   path=req.full_url.split('/api/v1')[1];body=json.loads(req.data) if req.data else None
   if path.startswith('/integrations/github/sync/settings'):
    return io.BytesIO(json.dumps({'enabled':enabled,'repositories':selected}).encode())
   if path=='/integrations/github/sync/status':return io.BytesIO(b'{"success":true}')
   if path=='/integrations/github/sync':
    response=json.loads(github(['gh','api',body['path']],input=json.dumps(body['changes']) if 'changes' in body else None).stdout)
    if isinstance(response,list) and response and isinstance(response[0],list):response=response[0]
    if '/labels?' in body['path']:response=response[(body['page']-1)*100:body['page']*100]
    return io.BytesIO(json.dumps(response).encode())
   board={'publicId':'board0000001','name':'GitHub: ClockworkDigital/test','workspace':{'publicId':sync.WORKSPACE},'visibility':'private','labels':list(kan_labels.values()),'lists':[{'name':'Open','publicId':'open00000001','cards':list(cards.values())},{'name':'Closed','publicId':'closed000001','cards':[]}]}
   if path=='/users/me':result={'id':'056107f2-7c89-4cba-9146-fc2d8a15f79d'}
   elif path.endswith('/permissions/me'):result={'permissions':['board:create','card:create','card:edit']}
   elif path.endswith('/boards'):result=board if body else []
   elif path.startswith('/boards/'):result=board
   elif path=='/labels':
    self.assertEqual(req.method,'POST')
    result={'publicId':f'label{len(kan_labels):07}', 'name':body['name'],'colourCode':body['colourCode']}
    kan_labels[result['publicId']]=result;label_writes.append('create')
   elif path.startswith('/labels/'):
    self.assertEqual(req.method,'PUT');result=kan_labels[path.split('/')[-1]];result.update(body);label_writes.append('update')
   elif '/labels/' in path:
    card=cards['card00000001'];identity=path.split('/')[-1]
    present=any(label['publicId']==identity for label in card['labels'])
    card['labels']=[label for label in card['labels'] if label['publicId']!=identity] if present else card['labels']+[kan_labels[identity].copy()]
    result={'newLabel':not present};label_writes.append('toggle')
   elif path=='/cards':
    cards['card00000001']={'publicId':'card00000001','title':body['title'],'description':body['description'],'githubRepository':body['githubRepository'],'githubIssueNumber':body['githubIssueNumber'],'labels':[kan_labels[identity].copy() for identity in body['labelPublicIds']],'list':{'publicId':body['listPublicId'],'board':{'publicId':board['publicId']}}};result=cards['card00000001'];writes.append('create')
   else:
    result=cards['card00000001']
    if body:
     for k,v in body.items():
      if k=='listPublicId':result['list']['publicId']=v
      else:result[k]=v
     writes.append('kan')
   return io.BytesIO(json.dumps(result).encode())
  with tempfile.TemporaryDirectory() as folder:
   profile=pathlib.Path(folder)/'profile';profile.write_text(json.dumps({'apiToken':'test','baseUrl':'https://formwork-poc.tail7c6e1a.ts.net:14443','expiresAt':'2099-01-01T00:00:00Z'}));profile.chmod(0o600)
   config=pathlib.Path(folder)/'config';config.write_text(json.dumps({'workspacePublicId':'workspace123','userId':'056107f2-7c89-4cba-9146-fc2d8a15f79d','baseUrl':'https://formwork-poc.tail7c6e1a.ts.net:14443'}))
   with patch.object(sync,'CONFIG',config),patch.object(sync,'STATE',pathlib.Path(folder)/'state'),patch.object(sync,'PROFILE',profile),patch.object(sync.subprocess,'run',side_effect=github),patch.object(sync.urllib.request,'build_opener',return_value=SimpleNamespace(open=api)),patch('sys.stdout',new=io.StringIO()):
    sync.main();sync.main();self.assertEqual(writes,['create'])
    enabled=False;sync.main();self.assertEqual(writes,['create'])
    enabled=True;selected.clear();sync.main();self.assertEqual(writes,['create'])
    selected.append('ClockworkDigital/test')
    # Cards from before the issue link column get it attached once from state; a different link is never overwritten.
    cards['card00000001'].update(githubRepository=None,githubIssueNumber=None)
    sync.main();sync.main();self.assertEqual(writes,['create','kan'])
    self.assertEqual((cards['card00000001']['githubRepository'],cards['card00000001']['githubIssueNumber']),('clockworkdigital/test',1))
    cards['card00000001']['githubIssueNumber']=2;issue['title']='Not synced'
    with self.assertRaises(SystemExit):sync.main()
    self.assertEqual(cards['card00000001']['title'],'Original');self.assertEqual(writes,['create','kan'])
    cards['card00000001']['githubIssueNumber']=1;writes.remove('kan')
    issue['title']='GitHub edit';sync.main();self.assertEqual(cards['card00000001']['title'],'GitHub edit')
    cards['card00000001']['title']='Kan edit';sync.main();self.assertEqual(issue['title'],'Kan edit')
    cards['card00000001']['list']['publicId']='closed000001';sync.main();self.assertEqual(issue['state'],'open');self.assertEqual(cards['card00000001']['list']['publicId'],'open00000001')
    issue['title']='Remote conflict';cards['card00000001']['title']='Local conflict'
    with self.assertRaises(SystemExit):sync.main()
    self.assertEqual(issue['title'],'Remote conflict');self.assertEqual(cards['card00000001']['title'],'Local conflict')

    if initial_labels:
     self.assertEqual(len(kan_labels),101)
     self.assertEqual(label_writes,['create']*101)
     self.assertEqual(cards['card00000001']['labels'][0]['name'],'initial')
     return

    # Upgrade an existing state file. Preserve an unrelated label with the same name.
    cards['card00000001']['title']=issue['title']
    local={'publicId':'local0000001','name':'bug','colourCode':'#ff0000'}
    kan_labels[local['publicId']]=local.copy()
    cards['card00000001']['labels']=[local.copy()]
    repo_labels.append({'id':10,'name':'bug','color':'FF0000'})
    issue['labels']=[repo_labels[0].copy()]
    sync.main();sync.main()
    mapped=json.loads((pathlib.Path(folder)/'state/state.json').read_text())['labels']['2']['labels']['10']['publicId']
    self.assertNotEqual(mapped,local['publicId'])
    self.assertEqual(len(kan_labels),2)
    self.assertEqual({x['publicId'] for x in cards['card00000001']['labels']},{mapped,local['publicId']})
    self.assertEqual(label_writes,['create','toggle'])
    baseline=copy.deepcopy(json.loads((pathlib.Path(folder)/'state/state.json').read_text())['issues'])
    standalone={'publicId':'standalone01','title':'Kan only','description':'Manual card', 'labels':[kan_labels[mapped].copy()], 'list':{'publicId':'open00000001','board':{'publicId':'board0000001'}}}
    cards['standalone01']=copy.deepcopy(standalone)
    # Rename and recolour by GitHub ID, retaining the Kan identity.
    repo_labels[0].update(name='defect',color='00ff00');issue['labels']=[repo_labels[0].copy()]
    sync.main();sync.main()
    self.assertEqual(kan_labels[mapped]['name'],'defect')
    self.assertEqual(kan_labels[mapped]['colourCode'],'#00ff00')
    self.assertEqual(kan_labels[local['publicId']],local)
    self.assertEqual(label_writes,['create','toggle','update'])
    # GitHub wins over a manual imported-label edit or assignment.
    kan_labels[mapped]['name']='manual';cards['card00000001']['labels']=[local.copy()]
    sync.main()
    self.assertEqual(kan_labels[mapped]['name'],'defect')
    issue['labels']=[];sync.main();sync.main()
    self.assertEqual(cards['card00000001']['labels'],[local])
    # Retire a repository label without deleting its board definition or Kan-only labels.
    issue['labels']=[repo_labels[0].copy()];sync.main()
    repo_labels.clear();issue['labels']=[];sync.main();sync.main()
    self.assertEqual(cards['card00000001']['labels'],[local])
    self.assertIn(mapped,kan_labels)
    self.assertEqual(cards['standalone01'],standalone)
    # A delete and re-create with the same name is a new GitHub identity.
    repo_labels.append({'id':11,'name':'defect','color':'00ff00'});issue['labels']=[repo_labels[0].copy()]
    sync.main();sync.main()
    self.assertEqual(len(kan_labels),3)
    self.assertEqual(len(cards['card00000001']['labels']),2)
    self.assertEqual(json.loads((pathlib.Path(folder)/'state/state.json').read_text())['issues'],baseline)
    # Closed issues leave the open listing but remain tracked for label changes.
    issue.update(state='closed',updated_at='closed',labels=[])
    sync.main();sync.main()
    self.assertEqual(cards['card00000001']['list']['publicId'],'closed000001')
    self.assertEqual(cards['card00000001']['labels'],[local])
    issue['labels']=[repo_labels[0].copy()]
    sync.main()
    closed_writes=label_writes.copy()
    sync.main()
    self.assertEqual(label_writes,closed_writes)
    self.assertEqual(len(cards['card00000001']['labels']),2)
    self.assertEqual(cards['standalone01'],standalone)

 def test_partial_label_pagination_failure_keeps_state_and_continues(self):
  self.label_read_failure(TimeoutError('Partial snapshot'), {'error':'TimeoutError'})

 def test_rejected_label_read_reports_status_without_secrets(self):
  import io
  from urllib.error import HTTPError
  for status in (403,502):
   with self.subTest(status=status):
    failure=HTTPError('https://kan.test/secret-url',status,'secret-reason',
                      {'Authorization':'Bearer secret-token'},io.BytesIO(b'secret-response'))
    try:self.label_read_failure(failure,{'error':'HTTPError','httpStatus':status})
    finally:failure.close()

 def label_read_failure(self,failure,expected):
  import sync, tempfile, pathlib, json, io
  from unittest.mock import patch
  from types import SimpleNamespace
  repos=[{'id':n,'full_name':f'ClockworkDigital/repo{n}','archived':False,'has_issues':True} for n in (1,2)]
  old={'boards':{'1':'board0000001','2':'board0000002'},'issues':{},'labels':{'1':{'board':'board0000001','labels':{'9':{'publicId':'label0000001'}}}}}
  calls=[]
  def api(req,**kw):
   path=req.full_url.split('/api/v1')[1];body=json.loads(req.data) if req.data else None
   calls.append((path,body))
   if path.startswith('/integrations/github/sync/settings'):
    result={'enabled':True,'repositories':[repo['full_name'] for repo in repos]}
   elif path=='/users/me':result={'id':'owner'}
   elif path.endswith('/permissions/me'):result={'permissions':['board:create','card:create','card:edit']}
   elif path.endswith('/boards'):result=[]
   elif path=='/integrations/github/sync/status':result={'success':True}
   elif path=='/integrations/github/sync':
    target=body['path']
    if target.startswith('orgs/'):result=repos
    elif '/issues?' in target:result=[]
    elif '/repo1/labels?' in target:
     if body['page']==2:raise failure
     result=[{'id':n,'name':str(n),'color':'abcdef'} for n in range(1,101)]
    elif '/repo2/labels?' in target:result=[]
    else:raise AssertionError(target)
   elif path.startswith('/boards/'):
    result={'publicId':path.split('/')[-1],'workspace':{'publicId':'workspace123'},'visibility':'private',
            'labels':[{'publicId':'label0000001','name':'old','colourCode':'#000000'}] if path.endswith('1') else [],
            'lists':[{'name':'Open','publicId':'open00000001','cards':[]},{'name':'Closed','publicId':'closed000001','cards':[]}]}
   else:raise AssertionError(f'Unexpected mutation: {path}')
   return io.BytesIO(json.dumps(result).encode())
  with tempfile.TemporaryDirectory() as folder:
   root=pathlib.Path(folder);state=root/'state';state.mkdir();(state/'state.json').write_text(json.dumps(old))
   profile=root/'profile';profile.write_text(json.dumps({'apiToken':'test','baseUrl':'https://kan.test'}));profile.chmod(0o600)
   config=root/'config';config.write_text(json.dumps({'workspacePublicId':'workspace123','userId':'owner','baseUrl':'https://kan.test'}))
   with patch.object(sync,'CONFIG',config),patch.object(sync,'STATE',state),patch.object(sync,'PROFILE',profile),patch.object(sync.urllib.request,'build_opener',return_value=SimpleNamespace(open=api)),patch('sys.stdout',new=io.StringIO()) as output:
    with self.assertRaises(SystemExit):sync.main()
   self.assertNotIn('secret-',output.getvalue())
   report=json.loads((state/'status.json').read_text())
   self.assertEqual(report['errors'],[{'repository':'ClockworkDigital/repo1','operation':'labels',**expected}])
   self.assertNotIn('secret-',json.dumps(report))
   self.assertIn(('/integrations/github/sync',{'workspacePublicId':'workspace123','path':'repos/ClockworkDigital/repo2/labels?per_page=100','page':1}),calls)
   # Existing repository boards are polled even with no open or tracked issues.
   after=json.loads((state/'state.json').read_text())
   self.assertEqual(after,old)
