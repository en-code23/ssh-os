export interface HelpArticle {
  id: string
  title: string
  body: string[]
}

/** Shown in the Help tab. Plain paragraphs; lines starting with "• " render as bullets, "$ " as commands. */
export const HELP: HelpArticle[] = [
  {
    id: 'start',
    title: 'Getting started',
    body: [
      'The Minecraft app manages Java Edition servers on any of your SSH servers. It finds existing servers automatically (any folder with a server.properties within 4 levels of your home folder, /opt, /srv, /home, /var/games, /mnt or /data) and can create new ones.',
      'Existing servers start out "unmanaged": you can browse and edit them, but start/stop, backups, schedules and updates need a small helper folder (.sshos) inside the server folder. Click "Set Up Management" to add it. Nothing else in your server is changed.',
      'To create a server, click + in the sidebar. Paper is the recommended choice: it is fast, supports plugins and updates automatically.',
    ],
  },
  {
    id: 'connect',
    title: 'How players connect (ports & firewall)',
    body: [
      'Players connect to the address of your machine and the server port (25565 by default, which they can leave out).',
      '• On the same network: use the local IP shown in the Overview tab, e.g. 192.168.1.20.',
      '• From the internet: forward TCP port 25565 (or your custom port) on your router to the machine, then share your public IP or a domain name.',
      '• If the machine runs a firewall, allow the port:',
      '$ sudo ufw allow 25565/tcp',
      'Each server on the same machine needs its own port. A domain with an SRV record lets players connect without typing the port.',
    ],
  },
  {
    id: 'eula',
    title: 'The Minecraft EULA',
    body: [
      'Mojang requires you to accept the Minecraft End User License Agreement before a server will start. SSH OS writes eula=true to eula.txt only after you tick the checkbox when creating a server.',
      'Read it at https://aka.ms/MinecraftEULA. Among other things, it limits how you may charge players for in-game advantages.',
    ],
  },
  {
    id: 'memory',
    title: 'Memory (RAM) and Java',
    body: [
      'Maximum memory (-Xmx) is how much RAM the server may use. Good starting points: 2 GB for a few friends on vanilla/Paper, 4–6 GB for 10–20 players or with plugins, 6–10 GB for modded servers.',
      'Leave at least 1–1.5 GB for the operating system. Giving Java more memory than needed does not make it faster and can cause longer garbage-collection pauses.',
      'Setting minimum memory (-Xms) equal to maximum reserves all RAM at start and is recommended by Paper (Aikar\'s flags assume it).',
      'Every Minecraft version needs a minimum Java version: 26.x needs Java 25, 1.20.5–1.21.x needs Java 21, 1.18–1.20.4 needs Java 17. SSH OS can download Eclipse Temurin Java into your home folder without sudo.',
    ],
  },
  {
    id: 'flags',
    title: 'JVM flags (Aikar\'s flags)',
    body: [
      'Aikar\'s flags tune the G1 garbage collector for Minecraft and reduce lag spikes. They are the community standard for Paper servers and are enabled by default.',
      '"Paper recommended" uses the flag set PaperMC publishes for your Minecraft version. Choose "None" only for troubleshooting or if a mod pack tells you to.',
    ],
  },
  {
    id: 'software',
    title: 'Choosing server software',
    body: [
      '• Paper: plugins (Bukkit/Spigot/Paper), best performance, frequent updates. Recommended.',
      '• Purpur: Paper plus many extra gameplay settings.',
      '• Folia: multi-threaded Paper for very large servers; most plugins do NOT work.',
      '• Fabric: mods instead of plugins. Many content mods also need to be installed by players.',
      '• Vanilla: the official server, data packs only.',
      'Plugins and mods are not interchangeable: a Paper server cannot run Fabric mods and vice versa.',
    ],
  },
  {
    id: 'content',
    title: 'Plugins, mods, data packs and resource packs',
    body: [
      'The Content tab installs add-ons directly from Modrinth, Hangar (PaperMC) and SpigotMC. Files are downloaded by the server itself, so even large mods install quickly.',
      '• Plugins go into plugins/ (Paper, Purpur, Folia, Spigot).',
      '• Mods go into mods/ (Fabric, Forge, NeoForge). Install "Fabric API" first on Fabric.',
      '• Data packs go into <world>/datapacks/ and work on every server type. Run /reload or restart to load them.',
      '• Resource packs are not installed on the server: players download them. SSH OS sets resource-pack and resource-pack-sha1 in server.properties so players are offered the pack when they join.',
      'Some SpigotMC plugins are hosted on external sites. SSH OS tries to find the .jar on GitHub releases; otherwise it opens the download page.',
      'Restart the server after installing or removing plugins or mods.',
    ],
  },
  {
    id: 'updates',
    title: 'Automatic updates',
    body: [
      'Server updates replace the server jar with the newest build for the same Minecraft version (e.g. Paper 1.21.4 build 230 → 232). These are bug and security fixes and are safe to install automatically.',
      '"Follow latest Minecraft version" also moves to new Minecraft versions. Worlds are converted when they are opened by a newer version and cannot be opened by older versions afterwards, and plugins may break. Only enable it if you are sure, and keep backups.',
      'Content updates check plugins, mods and data packs against Modrinth (by file hash), plus anything you installed from Hangar or SpigotMC.',
      'Updates are applied by .sshos/update.py on a schedule (cron) even when SSH OS is closed. Old jars are kept in .sshos/old-jars and .sshos/old-content so you can roll back.',
      'Choose whether the server restarts automatically after an update (players get a 30-second warning) or whether updates wait for the next restart.',
    ],
  },
  {
    id: 'backups',
    title: 'Backups',
    body: [
      'Backups are compressed .tar.gz archives in the backups/ folder of the server. "Worlds" backs up the overworld, nether and end; "Full" includes plugins, configs and everything else.',
      'While the server is running, saving is paused during the backup (save-off / save-all / save-on) so the archive is consistent.',
      'Retention keeps only the newest N backups. Backups on the same disk do not protect against disk failure; download important backups to your Mac from the Backups tab.',
      'Restoring replaces the current world folders; the server is stopped first.',
    ],
  },
  {
    id: 'autostart',
    title: 'Start on boot, crash restarts, scheduled restarts',
    body: [
      'Start on boot adds an @reboot entry to your user crontab. It needs the cron service, which most distributions have.',
      'Restart on crash: if the server process exits without being stopped by SSH OS, it is started again after 10 seconds, up to the configured number of times.',
      'Scheduled restarts (e.g. daily at 05:00) give players a 60-second warning. They are useful for long-running modded servers.',
      'The server runs inside a tmux or screen session if available (named after the server, e.g. mc-survival). You can attach from Terminal:',
      '$ tmux attach -t mc-survival',
      'Detach again with Ctrl-B then D. Typing "stop" there stops the server.',
    ],
  },
  {
    id: 'players',
    title: 'Ops, whitelist and bans',
    body: [
      'Operators (ops) can use admin commands. Level 4 can do everything including /stop.',
      'With the whitelist enabled, only listed players can join. Add your own name before enabling it.',
      'While the server runs, changes are applied with console commands. While it is stopped, SSH OS edits ops.json / whitelist.json directly, looking up player UUIDs from Mojang (online-mode servers only).',
    ],
  },
  {
    id: 'trouble',
    title: 'Troubleshooting',
    body: [
      '• "UnsupportedClassVersionError" in the console: Java is too old. Install the Java version shown in Startup settings.',
      '• "Failed to bind to port": another program (or another server) uses the port. Change server-port.',
      '• Server stops immediately: check that eula.txt contains eula=true and that the jar exists.',
      '• Out of memory / killed by the OS: lower Max memory or view-distance, or add swap.',
      '• Players time out: check port forwarding and the firewall. Test with the Network Utility port scan from another server.',
      '• Lag: reduce simulation-distance and view-distance, use Paper, and look for heavy plugins with /spark (install Spark from Modrinth).',
    ],
  },
]
