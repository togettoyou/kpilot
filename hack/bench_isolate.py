import os, subprocess, time, threading, sys
JWT = sys.argv[1]
HOST = sys.argv[2]
CID = sys.argv[3]
FROM = sys.argv[4]
TO = sys.argv[5]

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

# 1 logs in background (will be slow ~10s)
threads = [threading.Thread(target=req, args=('logs',
    f'{HOST}/api/v1/clusters/{CID}/logs/search?query=*&from={FROM}&to={TO}&limit=10000'))]
threads[0].start()
# wait until logs is mid-stream
time.sleep(5)
# fire 3 in parallel — but each one bypasses K8s API entirely
for i in range(3):
    t = threading.Thread(target=req, args=(f'bench#{i+1}',
        f'{HOST}/api/v1/clusters/{CID}/debug/tunnel-bench?bytes=4096'))
    t.start()
    threads.append(t)
for t in threads:
    t.join()
results.sort(key=lambda x: x[1])
for lbl, s, e, d in results:
    print(f'{lbl:10s}  start=T+{int(s*1000):>5d}ms  end=T+{int(e*1000):>5d}ms  duration={int(d*1000):>5d}ms')
