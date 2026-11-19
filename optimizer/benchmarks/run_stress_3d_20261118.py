import json, time, sys, random
from pathlib import Path
sys.path.insert(0,str(Path.cwd()))
from benchmark import build_request
from fastapi.testclient import TestClient
from app.main import app

def main():
    rng=random.Random(181126)
    p=build_request(500,120).model_dump(mode='json')
    p['orders']=p['orders'][:120]
    for k in ('distance_matrix_meters','duration_matrix_seconds'):
        p[k]=[r[:260] for r in p[k][:260]]
    for n,v in enumerate(p['vehicles']):
        v.update(length_cm=[600,900,1200][n%3],width_cm=240,height_cm=260,payload_limit_kg=[5000,10000,15000][n%3])
    for n,o in enumerate(p['orders']):
        items=[]
        for j in range(n%20+1):
            group=j//3
            length=60+10*((n+group)%5)
            width=50+10*((n+group)%4)
            tier=j%3
            weight=[100,20,4][tier]
            items.append(dict(id=f'cargo-{n}-{j}',order_id=o['id'],length_cm=length,width_cm=width,height_cm=25+5*((n+group)%4),weight_kg=weight,cargo_kind='STANDARD',allow_upper_tier=tier>0,max_top_load_g=30000 if tier==0 else 6000 if tier==1 else None,customer_id='stress-customer'))
        o['items']=items
        o['pickup_window_end_sec']=14400
        o['delivery_window_start_sec']=18000
        o['delivery_window_end_sec']=43200
    p.update(job_id='stress-120-orders-1260-items-20-vehicles',search_time_seconds=30,demo_stacking=dict(max_tiers=3,lift_clearance_cm=5,owner_mode='SAME_CUSTOMER'))
    out=Path('benchmarks/stress_3d_concurrent_20261118')
    out.mkdir(exist_ok=True)
    (out/'input.json').write_text(json.dumps(p,indent=2),encoding='utf-8')
    t=time.perf_counter()
    res=TestClient(app,raise_server_exceptions=False).post('/optimize-fleet/candidates',json=p)
    result=dict(elapsed_seconds=time.perf_counter()-t,http_status=res.status_code,orders=120,items=sum(len(o['items']) for o in p['orders']),vehicles=20,seed=181126,synthetic_matrix=True,response=res.json() if res.status_code==200 else res.text)
    (out/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print('SAVED',res.status_code,result['elapsed_seconds'],flush=True)
if __name__=='__main__':
    main()
