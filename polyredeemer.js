const { ethers } = require("ethers");
const axios = require("axios");
require("dotenv").config();

// --- CONFIG ---
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PK;
const MAIN_WALLET_RAW = process.env.PBK;

const MY_PROXY_ADDRESS = ""; 

const CTF_ADDRESS_RAW = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS_RAW = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const cleanAddress = (addr) => {
    if (!addr || addr.length < 40) return null;
    return ethers.getAddress(addr.toLowerCase());
};

const MAIN_WALLET = cleanAddress(MAIN_WALLET_RAW);
const CTF_ADDRESS = cleanAddress(CTF_ADDRESS_RAW);
const USDC_ADDRESS = cleanAddress(USDC_ADDRESS_RAW);

const PROXY_ABI = ["function proxy(address dest, bytes calldata data) external returns (bytes memory)"];
const CTF_ABI = [
    "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external"
];

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const ctfInterface = new ethers.Interface(CTF_ABI);

    console.log(`\n--- Scan started: ${new Date().toLocaleString()} ---`);

    let proxyAddress = cleanAddress(MY_PROXY_ADDRESS);
    if (!proxyAddress) {
        try {
            const profileRes = await axios.get(`https://data-api.polymarket.com/profile?address=${MAIN_WALLET}`);
            if (profileRes.data && profileRes.data.proxyAddress) {
                proxyAddress = cleanAddress(profileRes.data.proxyAddress);
            }
        } catch (e) { /* API error ignore */ }
    }

    const targetAddress = proxyAddress || MAIN_WALLET;
    console.log("Target Wallet:", targetAddress);

    try {
        const allPos = await axios.get(`https://data-api.polymarket.com/positions?user=${targetAddress}`);
        console.log(`Total positions (open+closes): ${allPos.data.length}`);
    } catch (e) { console.log("Can't find positions"); }

    let conditionIds = [];
    try {
        const posRes = await axios.get(`https://data-api.polymarket.com/positions?user=${targetAddress}&redeemable=true`);
        conditionIds = [...new Set(posRes.data.map(p => p.conditionId))];
    } catch (e) { return console.log("Polymarket API unreachable."); }

    if (conditionIds.length === 0) {
        console.log("No positions found to claim");
        return;
    }

    console.log(`Found: ${conditionIds.length} markets to claim.`);

    for (const conditionId of conditionIds) {
        try {
            const feeData = await provider.getFeeData();
            const maxPriorityFee = (feeData.maxPriorityFeePerGas * 130n) / 100n;
            const maxFee = (feeData.maxFeePerGas * 130n) / 100n;

            console.log(`\nClaiming: ${conditionId}`);

            const redeemData = ctfInterface.encodeFunctionData("redeemPositions", [
                USDC_ADDRESS, ethers.ZeroHash, conditionId, [1, 2]
            ]);

            const txDetails = { maxPriorityFeePerGas: maxPriorityFee, maxFeePerGas: maxFee };

            let tx;
            if (proxyAddress && proxyAddress !== MAIN_WALLET) {
                const proxyContract = new ethers.Contract(proxyAddress, PROXY_ABI, wallet);
                tx = await proxyContract.proxy(CTF_ADDRESS, redeemData, txDetails);
            } else {
                const ctfContract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
                tx = await ctfContract.redeemPositions(USDC_ADDRESS, ethers.ZeroHash, conditionId, [1, 2], txDetails);
            }

            console.log("Send! Hash:", tx.hash);
            const receipt = await Promise.race([
                tx.wait(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 45000))
            ]);
            console.log("Confirmed in blockchain:", receipt.blockNumber);
        } catch (err) {
            console.error("Error:", err.shortMessage || err.message);
        }
    }
}

async function runForever() {
    while (true) {
        try { await main(); } catch (e) { console.error("Loop error:", e.message); }
        console.log(`\nWaiting for 15 minutes`);
        await new Promise(r => setTimeout(r, 15 * 60 * 1000));
    }
}

runForever();
