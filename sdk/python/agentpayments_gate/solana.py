import hashlib
import logging

import requests

logger = logging.getLogger(__name__)

USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
RPC_DEVNET = "https://api.devnet.solana.com"
RPC_MAINNET = "https://api.mainnet-beta.solana.com"
MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
MIN_PAYMENT = 0.01


def _rpc_call(rpc_url: str, method: str, params: list) -> dict:
    resp = requests.post(
        rpc_url,
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_ED25519_P = 2**255 - 19
_ED25519_D = 37095705934669439343138083508754565189542113879843219016388785533085940283555
_ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
_TOKEN_PROGRAM_ADDR = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"


def _b58decode(s: str) -> bytes:
    n = 0
    for c in s:
        n = n * 58 + _B58.index(c)
    raw = n.to_bytes(max((n.bit_length() + 7) // 8, 1), "big") if n else b""
    leading = len(s) - len(s.lstrip("1"))
    out = b"\x00" * leading + raw
    return out.rjust(32, b"\x00")


def _b58encode(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    s = ""
    while n > 0:
        n, r = divmod(n, 58)
        s = _B58[r] + s
    for b in data:
        if b != 0:
            break
        s = "1" + s
    return s


def _is_on_curve(data: bytes) -> bool:
    p = _ED25519_P
    y_bytes = bytearray(data)
    y_bytes[31] &= 0x7F
    y = int.from_bytes(y_bytes, "little")
    if y >= p:
        return False
    y2 = y * y % p
    x2 = (y2 - 1) % p * pow((1 + _ED25519_D * y2) % p, p - 2, p) % p
    if x2 == 0:
        return True
    return pow(x2, (p - 1) // 2, p) == 1


def _derive_ata(owner: str, mint: str) -> str | None:
    seeds = [_b58decode(owner), _b58decode(_TOKEN_PROGRAM_ADDR), _b58decode(mint)]
    program_id = _b58decode(_ASSOCIATED_TOKEN_PROGRAM)
    suffix = b"ProgramDerivedAddress"
    for bump in range(255, -1, -1):
        buf = b"".join(seeds) + bytes([bump]) + program_id + suffix
        h = hashlib.sha256(buf).digest()
        if not _is_on_curve(h):
            return _b58encode(h)
    return None


def verify_payment_on_chain(
    agent_key: str,
    wallet_address: str,
    rpc_url: str,
    usdc_mint: str,
) -> bool:
    try:
        derived_ata = _derive_ata(wallet_address, usdc_mint)

        rpc_accounts = []
        try:
            ata_data = _rpc_call(rpc_url, "getTokenAccountsByOwner", [
                wallet_address,
                {"mint": usdc_mint},
                {"encoding": "jsonParsed", "commitment": "confirmed"},
            ])
            rpc_accounts = [a["pubkey"] for a in ata_data.get("result", {}).get("value", [])]
        except Exception:
            logger.warning("[gate] getTokenAccountsByOwner failed, using derived ATA")

        address_set = {wallet_address, *rpc_accounts}
        if derived_ata:
            address_set.add(derived_ata)
        addresses_to_scan = list(address_set)
        seen = set()
        all_signatures = []

        for addr in addresses_to_scan:
            sigs_data = _rpc_call(rpc_url, "getSignaturesForAddress", [addr, {"limit": 50, "commitment": "confirmed"}])
            for sig in sigs_data.get("result", []):
                if sig["signature"] not in seen:
                    seen.add(sig["signature"])
                    all_signatures.append(sig)

        for sig_info in all_signatures:
            if sig_info.get("err"):
                continue

            tx_data = _rpc_call(rpc_url, "getTransaction", [
                sig_info["signature"],
                {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0, "commitment": "confirmed"},
            ])
            tx = tx_data.get("result")
            if not tx:
                continue

            instructions = tx.get("transaction", {}).get("message", {}).get("instructions", [])
            inner_instructions = tx.get("meta", {}).get("innerInstructions", [])

            all_ix = list(instructions)
            for group in inner_instructions:
                all_ix.extend(group.get("instructions", []))

            has_memo = False
            has_payment = False

            for ix in all_ix:
                program = ix.get("program", "")
                program_id = ix.get("programId", "")
                if program == "spl-memo" or program_id == MEMO_PROGRAM:
                    parsed = ix.get("parsed", "")
                    memo_text = parsed if isinstance(parsed, str) else str(parsed)
                    if agent_key in memo_text:
                        has_memo = True

                if program == "spl-token":
                    parsed = ix.get("parsed", {})
                    tx_type = parsed.get("type", "")
                    if tx_type in ("transfer", "transferChecked"):
                        info = parsed.get("info", {})
                        if tx_type == "transferChecked" and info.get("mint") != usdc_mint:
                            continue

                        token_amount = info.get("tokenAmount", {})
                        ui_amount = token_amount.get("uiAmount")
                        if ui_amount is None:
                            raw = info.get("amount", "0")
                            ui_amount = int(raw) / 1e6

                        if ui_amount >= MIN_PAYMENT:
                            has_payment = True

            if has_memo and has_payment:
                return True

    except Exception:
        logger.exception("[gate] Solana RPC error")

    return False
