# Havix

[中文](./README.zh-CN.md)

**Haven of Affinity** — a protocol for **unlinkable parallel identities and a dual-track reputation/credit economy**, anchored on a single main DID. Transport runs on a P2P overlay (libp2p + IPFS/Helia).

> One person holds one main DID (Ed25519). From it, HKDF derives four **context identities (A/B/C/D)** that are cryptographically unlinkable — an outside observer cannot correlate your activity across contexts. "One person, four contextual personas." On top of that identity layer, Havix runs a small, fully specified economy with arbitration. The project began as an experiment testing the "stratified self-organizing network" hypothesis from a sociology paper; it has since delivered and tested its verification form (M1–M10).

## Core mechanisms

| Mechanism | What it does |
|---|---|
| **4-context DIDs** | main DID → HKDF → A/B/C/D unlinkable identities; each context signs with its own key, no cross-context linkage |
| **Reputation track** | long-lived, non-transferable social capital; high reputation earns issuance rights |
| **Credit track** | transferable value notes, issued through a Faucet |
| **Faucet anchoring** | issuing Credit **freezes an equal amount of the issuer's own reputation**; consumption releases the freeze — value expansion is always backed by reputation, and total reputation is conserved |
| **Arbitration** | ad-hoc 5-person panels summoned per dispute; verdicts execute as reputation slashes: 50% to the damaged party, 50% to the treasury |
| **Slash boundary** | only *frozen* reputation can ever be slashed — governance cannot weaponize itself against liquid capital |
| **Relay tunnels** | single-hop cover traffic for transport-layer unobservability |
| **Invite markets** | permissioned sub-networks with layered encryption (public-key + per-topic AES-GCM), invite tokens self-verify without any DHT lookup |
| **Non-DAO principles** | no on-chain voting, no token economy, no governance token — Havix mints nothing that trades |

## Implemented milestones (M1–M10, all delivered)

| M | Capability |
|---|---|
| M1 | dual-plane transport baseline (libp2p + IPFS) |
| M2 | DID derivation + public-layer message signing |
| M3 | wiki protocol (vouch-gated collaborative records, version chains on IPFS) |
| M4 | dual-track credit economy |
| M5 | single-hop relay tunnels |
| M6 | ad-hoc arbitration panels + slashing |
| M7 | invite-based markets + layered encryption |
| M8 | ledger persistence + CLI REPL + local web panel |
| M9 | App SDK (manifest, permission whitelist, AppManager) |
| M10 | end-to-end validation via a real market app (an invite-based translation marketplace; results folded back into the protocol) |

## Security posture

**Two audit rounds, both closed:**

- **M9 audit** — 15 findings (6 P0 / 6 P1 / 3 P2), all fixed. Highlights: signatures now cover the entire canonical message (previously only the payload — an attacker could tamper with `senderId`/`type` without breaking the signature); double-layer verification of credit notes (inner-note signature + `senderId === issuerDid` binding); invite-token self-verification (embedded public key, no DHT dependency); top-level try/catch around gossipsub dispatch (DoS containment); LRU bounds on all unbounded Set/Map ledgers.
- **M10 deep audit** — 52 findings (5 P0 / 15 P1 fixed and closed; 32 P2 scheduled into M11).

**Known limits (documented, not hidden):**

- Node identity is currently ephemeral across restarts (a fresh keypair per start) — persisted ledger state keyed to external DIDs survives, node-own DIDs become orphaned data; identity persistence is future work.
- Local ledgers are plaintext JSON (AES-GCM encryption of local state is scheduled after M9).
- Cross-node reputation state converges via gossip messages; there is no reputation sync protocol yet.

Details for every fix and design decision are in the development log ([README.zh-CN.md](./README.zh-CN.md), in Chinese).

## Verify it yourself

```bash
git clone https://github.com/eneatlnc-cell/Havix.git
cd Havix
npm install && cp .env.example .env

npm test                                   # full unit + e2e + SDK suite (~55 s)
node src/s-node.js --port 9001 --name alpha  # start a node: CLI REPL + web panel on 127.0.0.1:7331
```

Two nodes discover each other over mDNS on a LAN, or via explicit `--bootstrap /ip4/.../p2p/<peerId>` across networks. The web panel is GET-only, binds to 127.0.0.1 only, and never displays private keys.

## Documentation

Mostly in Chinese, linked here for precision:

- [Technical Whitepaper](./Havix-Technical-Whitepaper.md) — full protocol design
- [DEPLOY.md](./DEPLOY.md) — deployment and operations
- [ROADMAP.md](./ROADMAP.md) · [NEXT-STEPS.md](./NEXT-STEPS.md) — post-MVP direction, M11 planning
- [M9-DESIGN.md](./M9-DESIGN.md) — App SDK design
- [README.zh-CN.md](./README.zh-CN.md) — complete milestone-by-milestone development log

## License

**AGPL-3.0-only** — the network layer is the trust root: unlinkable DIDs, device anchoring, ledger integrity. Strong copyleft is a security commitment: anyone who runs a modified Havix node and lets the public talk to it must publish their modifications (AGPL §13). You cannot quietly fork the trust substrate and weaken it behind a closed relay.

- Full license text: [LICENSE](./LICENSE) · Notices: [NOTICE](./NOTICE)
- Copyright: © 2024-2026 Havix Contributors
- Every source file carries `SPDX-License-Identifier: AGPL-3.0-only`

## Disclaimer

Havix is for research and protocol-validation purposes. See Whitepaper chapter 15 for details.
