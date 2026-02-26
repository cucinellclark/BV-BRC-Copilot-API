module.exports = {
  apps: [{
    name: "Copilot-Utilities-Development",
    script: "./start_copilot_utilities.sh",
    cwd: "/home/ac.cucinell/bvbrc-dev/Copilot/DevEnvironment/BV-BRC-Copilot-API/utilities",
    interpreter: "/bin/bash",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    watch: false,
    max_memory_restart: "8G",
    error_file: "/home/ac.cucinell/bvbrc-dev/Copilot/DevEnvironment/copilot-logs/utilities.error.log",
    out_file: "/home/ac.cucinell/bvbrc-dev/Copilot/DevEnvironment/copilot-logs/utilities.out.log"
  }]
}

