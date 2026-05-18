import os, subprocess, time, threading, sys
JWT = sys.argv[1]
HOST = sys.argv[2]
CID = sys.argv[3]
FROM = sys.argv[4]
TO = sys.argv[5]
N = int(sys.argv[6])  # number of concurrent nodes
DELAY_MS = int(sys.argv[7])  # when to fire nodes (ms after logs)

T0 = time.time()
results = []
lock = threading.Lock()

def req(label, url):
    s = time.time() - T0
    subprocess.run(['curl','-s','-H',f'Cookie: kpilot_token={JWT}',
                    '-H','Accept-Encoding: identity','-o','NUL' if os.name=='nt' else '/dev/null',
                    url], check=False)
    e = time.time() - T0
    with lock:
        results.append((label, s, e, e-s))

threads = [threading.Thread(target=req, args=('logs',
    f'{HOST}/api/v1/clusters/{CID}/logs/search?query=*&from={FROM}&to={TO}&limit=10000'))]
threads[0].start()
time.sleep(DELAY_MS / 1000.0)
for i in range(N):
    t = threading.Thread(target=req, args=(f'nodes#{i+1}',
        f'{HOST}/api/v1/clusters/{CID}/workloads/nodes?limit=100'))
    t.start()
    threads.append(t)
for t in threads: t.join()
results.sort(key=lambda x: x[1])
for lbl, s, e, d in results:
    print(f'  {lbl:10s}  start=T+{int(s*1000):>5d}ms  end=T+{int(e*1000):>5d}ms  duration={int(d*1000):>5d}ms')
