WA Logger Ultimate (modified)
==================
This repository is the original 'wa-logger-ultimate' with added features:
- !menu (format B)
- !ping (detailed system stats: CPU, RAM, GPU if available, disk, uptime, latency)
- !setowner (sets bot itself as owner to prevent double-forward)
- Anti-double-forward using data/forwarded.json

Usage:
1. npm install
2. npm start
3. Scan QR when shown in terminal (ASCII).
4. In the group you want as backup: send !setgroupbackup
5. Send !setowner to let the bot record its own id to prevent double-forwarding
6. Use !menu and !ping as needed

Notes:
- This build keeps the original dependencies and Baileys version unchanged.
- Designed to run on Termux/Ubuntu; ping collects info using /proc and standard tools.
