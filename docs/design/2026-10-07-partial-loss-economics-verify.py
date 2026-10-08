from fractions import Fraction as F
BPS=10_000
WIN,REF,ADM,MEG = 900,8900,100,100
AWARD,FIELD = 5000,4000
def split(total):
    w=total*WIN//BPS; a=total*ADM//BPS; m=total*MEG//BPS
    return w, total-w-a-m, a, m          # refund_pool is the residual
def share(amt,pool,total): return amt*pool//total if total else 0

print("== 1. four-way conservation + v1 reproduction ==")
for t in [0,1,99,100,150,10_000,7_777_777_777,10**10,2**64-1]:
    w,r,a,m = split(t); assert w+r+a+m==t, t
    assert r >= t*REF//BPS and r <= t*REF//BPS+3, (t,r)
print("  I18 exact & refund_pool within +3 of nominal, for all probes: OK")
def split_v1(total):          # winner_bps 9800 -> refund slice collapses to 0
    w=total*9800//BPS; a=total*100//BPS; m=total*100//BPS
    return w, total-w-a-m, a, m
for t in [0,1,99,150,10_000,7_770_000_000,2**64-1]:
    w,r,a,m = split_v1(t)
    assert (w,a,m)==(total_v1:=(t*9800//BPS), t*100//BPS, t*100//BPS)
    assert r==t-w-a-m and r<=2, (t,r)   # v1 dust, previously the winner's
print("  R6: winner_bps=9800 reproduces v1 cuts, refund_pool is 0..2 dust: OK")

print("== 2. EV is flat -2% of stake, independent of pot share and wallet count ==")
for P in [10**10, 7_777_777_777, 10**12]:
    w,r,a,m = split(P)
    for k in [1,2,5,10,50]:
        for theta in [F(1,100),F(1,2),F(99,100),F(1)]:
            agg = int(P*theta); 
            if agg < k: continue
            s = agg//k                      # k equal attacker wallets
            ev = k*(F(s,P)*w + share(s,r,P) - s)
            rel = ev/agg
            assert abs(rel - F(-(ADM+MEG),BPS)) < F(1,10**6), (P,k,theta,float(rel))
print("  EV/stake == -0.0200 for every (pot, wallets k, share theta): OK")
print("  literal-brief EV for comparison (theta->1 whale):")
for theta in [F(1,100),F(1,2),F(9,10),F(99,100),F(999,1000)]:
    print(f"    theta={float(theta):<6} EV/stake = {float(-F(2,100)*(1-theta)):+.5f}")

print("== 3. no-overdraw lemma vs the forbidden formula ==")
import random
random.seed(7)
worst=0
for _ in range(4000):
    n=random.randint(1,200)
    amts=[random.randint(1,10**12) for _ in range(n)]
    T=sum(amts); w,r,a,m=split(T)
    paid=sum(share(x,r,T) for x in amts)
    assert paid<=r, "OVERDRAW"
    worst=max(worst,r-paid)
    assert r-paid<=n-1
print(f"  sum(entry_share) <= refund_pool on 4000 random partitions; worst dust {worst} lamports: OK")
T=100; amts=[1]*100; w,r,a,m=split(T)
good=sum(share(x,r,T) for x in amts); bad=sum(x - x*1100//BPS for x in amts)
print(f"  100x1-lamport round: refund_pool={r}  pro-rata pays={good} (dust {r-good})  naive pays={bad} -> overdraw {bad-r}")
assert good<=r and bad>r

print("== 4. I21 farming guard ==")
def cap_bound(N): return N*(ADM+MEG)
for N in [625,2500,6767]:
    print(f"  N={N:<5} max safe cap_bps={cap_bound(N):>9,} ({cap_bound(N)/BPS:>5.1f}x pot)   shipped 80,000 safe? {80_000<=cap_bound(N)}")
# EV with the cap, swept over theta/P/M
CAP=80_000; N=625
bad=[]
for M in [10**9,10**11,10**13]:
    for P in [10**8,10**10,10**12]:
        nominal=M*(AWARD+FIELD)//BPS; payable=min(nominal, P*CAP//BPS)
        for theta in [F(1,100),F(1,2),F(1)]:
            ev = theta*F(payable,N) - F(ADM+MEG,BPS)*theta*P
            if ev>0: bad.append((M,P,float(theta),float(ev)))
print(f"  capped EV>0 cases across M/P/theta sweep: {len(bad)} (expect 0)"); assert not bad
# and show the uncapped hole it closes
bad_unc=[(M,P) for M in [10**11] for P in [10**8,10**9]
         if F(M*(AWARD+FIELD)//BPS,N) - F(ADM+MEG,BPS)*P > 0]
print(f"  uncapped: {len(bad_unc)} of those same rounds are +EV -> the hole the cap closes")

print("== 5. mega split conservation, capped and uncapped ==")
def msplit(acc,total,cap_bps):
    g=AWARD+FIELD; nom=acc*g//BPS
    pay=nom if cap_bps==0 else min(nom, total*cap_bps//BPS)
    aw=pay*AWARD//g if g else 0
    return aw, pay-aw, acc-pay
for acc in [0,1,10,10**11,2**64-1]:
    for total in [1,10**10,2**64-1]:
        for cb in [0,80_000]:
            aw,fd,rt=msplit(acc,total,cb); assert aw+fd+rt==acc,(acc,total,cb)
print("  I19 exact for all probes: OK")
aw,fd,rt=msplit(10**11,2*10**10,80_000)
print(f"  M=100 SOL, pot=20 SOL, cap 8x -> awarded {aw/1e9:.2f} field {fd/1e9:.2f} retained {rt/1e9:.2f} (uncapped)")
aw,fd,rt=msplit(10**11,10**10,80_000)
print(f"  M=100 SOL, pot=10 SOL, cap 8x -> awarded {aw/1e9:.3f} field {fd/1e9:.3f} retained {rt/1e9:.2f} (CAP BINDS)")

print("== 6. layout byte arithmetic ==")
gc=2+2+4+8+1; rd=8*4
print(f"  GlobalConfig new fields {gc}B, reserved 47 -> {47-gc}; total stays 340: {47-gc==30}")
print(f"  Round        new fields {rd}B, reserved 64 -> {64-rd}; total stays 302: {64-rd==32}")
assert 47-gc==30 and 64-rd==32

print("== 7. sizing / RTP ==")
for N in [625,2500,6767]:
    Mstar=F(MEG,BPS)*N/(F(AWARD+FIELD,BPS)); print(f"  N={N:<5} M*/Pbar={float(Mstar):6.2f}x  winner 5/9 of it={float(Mstar*F(AWARD,AWARD+FIELD)):6.2f}x pot  pops/day@180s={86400/(180*N):.3f}")
print(f"  RTP = 1 - admin_bps/BPS = {1-F(ADM,BPS):.4f} (mega slice returns to players in steady state)")
print(f"  half-life of a bankroll at 89% retention: {__import__('math').log(0.5)/__import__('math').log(0.89):.2f} rounds")
print(f"  escrow rent (128+122)*3480*2 = {(128+122)*3480*2:,} lamports = {(128+122)*3480*2/1e9:.5f} SOL")
print("\nALL CHECKS PASSED")
