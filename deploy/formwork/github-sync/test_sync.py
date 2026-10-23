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
 def test_import_repeat_both_directions_and_conflict(self):
  import sync, tempfile, pathlib, json, io, copy
  from unittest.mock import patch
  from types import SimpleNamespace
  issue={'id':1,'number':1,'title':'Original','body':'Body\n\n- Item','state':'open','updated_at':'one','html_url':'https://github.com/ClockworkDigital/test/issues/1'}
  repo={'id':2,'full_name':'ClockworkDigital/test','archived':False,'has_issues':True,'permissions':{'push':True}}
  cards={};writes=[];selected=['ClockworkDigital/test'];enabled=True
  def github(args,**kw):
   path=args[2]
   if path.startswith('orgs/'):result=[[repo]]
   elif kw.get('input'):
    issue.update(json.loads(kw['input']));writes.append('github');result=issue
   elif '?' in path:result=[[issue]]
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
    return io.BytesIO(json.dumps(response).encode())
   board={'publicId':'board0000001','name':'GitHub: ClockworkDigital/test','workspace':{'publicId':sync.WORKSPACE},'visibility':'private','lists':[{'name':'Open','publicId':'open00000001','cards':list(cards.values())},{'name':'Closed','publicId':'closed000001','cards':[]}]}
   if path=='/users/me':result={'id':'056107f2-7c89-4cba-9146-fc2d8a15f79d'}
   elif path.endswith('/permissions/me'):result={'permissions':['board:create','card:create','card:edit']}
   elif path.endswith('/boards'):result=board if body else []
   elif path.startswith('/boards/'):result=board
   elif path=='/cards':
    cards['card00000001']={'publicId':'card00000001','title':body['title'],'description':body['description'],'list':{'publicId':body['listPublicId'],'board':{'publicId':board['publicId']}}};result=cards['card00000001'];writes.append('create')
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
    issue['title']='GitHub edit';sync.main();self.assertEqual(cards['card00000001']['title'],'GitHub edit')
    cards['card00000001']['title']='Kan edit';sync.main();self.assertEqual(issue['title'],'Kan edit')
    cards['card00000001']['list']['publicId']='closed000001';sync.main();self.assertEqual(issue['state'],'open');self.assertEqual(cards['card00000001']['list']['publicId'],'open00000001')
    issue['title']='Remote conflict';cards['card00000001']['title']='Local conflict'
    with self.assertRaises(SystemExit):sync.main()
    self.assertEqual(issue['title'],'Remote conflict');self.assertEqual(cards['card00000001']['title'],'Local conflict')
