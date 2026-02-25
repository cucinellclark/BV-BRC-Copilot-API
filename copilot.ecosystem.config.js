module.exports = {
  apps : [
  {
    name   : "",
    cwd: "/disks/p3/copilot-alpha/BV-BRC-Copilot-API",
    exec_mode: "cluster",
    instances: 1,
    cron_restart: "30 4 * * *",
    script : "/disks/p3/copilot-alpha/BV-BRC-Copilot-API/bin/launch-copilot",
    error_file: "/disks/p3/copilot-alpha/logs/p3-web.error.log",
    out_file: "/disks/p3/copilot-alpha/logs/p3-web.out.log",
    pid_file: "/disks/p3/copilot-alpha/logs/p3-web.pid",
  }
  ]
}
