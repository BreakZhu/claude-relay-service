#!/usr/bin/env node

const { spawn, exec } = require('child_process')
const fs = require('fs')
const path = require('path')
const process = require('process')

const PID_FILE = path.join(__dirname, '..', 'claude-relay-service.pid')
const LOG_FILE = path.join(__dirname, '..', 'logs', 'service.log')
const ERROR_LOG_FILE = path.join(__dirname, '..', 'logs', 'service-error.log')
const APP_FILE = path.join(__dirname, '..', 'src', 'app.js')
const STARTUP_MARKER_FILE = path.join(__dirname, '..', '.startup-ready') // 🔥 新增启动标记文件

class ServiceManager {
  constructor() {
    this.ensureLogDir()
  }

  ensureLogDir() {
    const logDir = path.dirname(LOG_FILE)
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }
  }

  getPid() {
    try {
      if (fs.existsSync(PID_FILE)) {
        const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim())
        return pid
      }
    } catch (error) {
      console.error('读取PID文件失败:', error.message)
    }
    return null
  }

  isProcessRunning(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return false
    }
  }

  writePid(pid) {
    try {
      fs.writeFileSync(PID_FILE, pid.toString())
      console.log(`✅ PID ${pid} 已保存到 ${PID_FILE}`)
    } catch (error) {
      console.error('写入PID文件失败:', error.message)
    }
  }

  removePidFile() {
    try {
      if (fs.existsSync(PID_FILE)) {
        fs.unlinkSync(PID_FILE)
        console.log('🗑️  已清理PID文件')
      }
      // 🔥 同时清理启动标记文件
      if (fs.existsSync(STARTUP_MARKER_FILE)) {
        fs.unlinkSync(STARTUP_MARKER_FILE)
        console.log('🗑️  已清理启动标记文件')
      }
    } catch (error) {
      console.error('清理文件失败:', error.message)
    }
  }

  getStatus() {
    const pid = this.getPid()
    if (pid && this.isProcessRunning(pid)) {
      return { running: true, pid }
    }
    return { running: false, pid: null }
  }

  start(daemon = false) {
    const status = this.getStatus()
    if (status.running) {
      console.log(`⚠️  服务已在运行中 (PID: ${status.pid})`)
      return false
    }

    console.log('🚀 启动 Claude Relay Service...')

    // 🔥 清理旧的启动标记文件
    if (fs.existsSync(STARTUP_MARKER_FILE)) {
      try {
        fs.unlinkSync(STARTUP_MARKER_FILE)
      } catch (error) {
        console.warn('⚠️  清理旧启动标记失败:', error.message)
      }
    }

    if (daemon) {
      // 后台运行模式（跨平台）：使用detached spawn并将输出重定向到日志文件
      try {
        // 以追加方式打开日志文件句柄
        const outFd = fs.openSync(LOG_FILE, 'a')
        const errFd = fs.openSync(ERROR_LOG_FILE, 'a')

        const child = spawn('node', [APP_FILE], {
          cwd: path.join(__dirname, '..'),
          env: process.env,
          detached: true,
          stdio: ['ignore', outFd, errFd]
        })

        // 使子进程在父进程退出后继续存活
        child.unref()

        console.log(`🔄 服务已在后台启动 (PID: ${child.pid})`)
        this.writePid(child.pid)
        console.log(`📝 日志文件: ${LOG_FILE}`)
        console.log(`❌ 错误日志: ${ERROR_LOG_FILE}`)

        // 等待服务启动并检查状态
        console.log('⏳ 等待服务启动...')

        let checkCount = 0
        const maxChecks = 30 // 🔥 增加检查次数到30次（6秒）
        const checkInterval = setInterval(() => {
          checkCount++

          // 检查进程是否还在运行
          if (!this.isProcessRunning(child.pid)) {
            clearInterval(checkInterval)
            console.log('❌ 服务启动失败，进程已退出')
            console.log('📄 查看错误日志:')
            console.log(`   tail -n 50 ${ERROR_LOG_FILE}`)
            console.log('📄 或查看服务日志:')
            console.log(`   tail -n 50 ${LOG_FILE}`)
            this.removePidFile()
            process.exit(1)
          }

          // 🔥 优先检查启动标记文件（更可靠）
          if (fs.existsSync(STARTUP_MARKER_FILE)) {
            try {
              const markerData = JSON.parse(fs.readFileSync(STARTUP_MARKER_FILE, 'utf8'))
              if (markerData.pid === child.pid) {
                clearInterval(checkInterval)
                console.log('✅ 服务启动成功！')
                console.log(`✅ 服务运行在端口: ${markerData.port}`)
                console.log('✅ 终端现在可以安全关闭')
                console.log('\n💡 查看实时日志:')
                console.log(`   npm run service:logs:follow`)
                console.log('💡 查看服务状态:')
                console.log(`   npm run service:status`)
                process.exit(0)
              }
            } catch (error) {
              // 标记文件可能还没完全写入，继续等待
            }
          }

          // 🔥 备用检查：检查日志文件中的启动标志
          try {
            if (fs.existsSync(LOG_FILE)) {
              const logContent = fs.readFileSync(LOG_FILE, 'utf8')
              const recentLog = logContent.split('\n').slice(-30).join('\n')

              // 检查是否有启动成功的标志
              if (recentLog.includes('Claude Relay Service started on')) {
                clearInterval(checkInterval)
                console.log('✅ 服务启动成功！（通过日志检测）')
                console.log('✅ 终端现在可以安全关闭')
                console.log('\n💡 查看实时日志:')
                console.log(`   npm run service:logs:follow`)
                console.log('💡 查看服务状态:')
                console.log(`   npm run service:status`)
                process.exit(0)
              }

              // 检查是否有启动失败的标志
              if (
                recentLog.includes('Failed to start server') ||
                recentLog.includes('Application initialization failed') ||
                recentLog.includes('Failed to connect to Redis')
              ) {
                clearInterval(checkInterval)
                console.log('❌ 服务启动失败，检测到错误')
                console.log('\n📄 最近的错误日志:')
                const errorLines = recentLog.split('\n').filter((line) => line.includes('ERROR'))
                errorLines.slice(-5).forEach((line) => console.log(`   ${line}`))
                console.log('\n📄 查看完整日志:')
                console.log(`   tail -n 50 ${LOG_FILE}`)
                console.log(`   tail -n 50 ${ERROR_LOG_FILE}`)
                this.removePidFile()
                // 终止子进程
                try {
                  process.kill(child.pid, 'SIGTERM')
                } catch (e) {
                  // 进程可能已经退出
                }
                process.exit(1)
              }
            }
          } catch (error) {
            // 日志文件可能还没创建，继续等待
          }

          if (checkCount >= maxChecks) {
            clearInterval(checkInterval)
            console.log('⚠️  服务启动超时（6秒内未检测到启动完成）')
            console.log('⚠️  服务可能仍在后台启动中，请稍后检查状态')
            console.log('\n💡 查看服务状态:')
            console.log(`   npm run service:status`)
            console.log('💡 查看日志:')
            console.log(`   tail -f ${LOG_FILE}`)
            process.exit(0)
          }
        }, 200)
      } catch (error) {
        console.error('❌ 后台启动失败:', error.message)
        this.removePidFile()
        process.exit(1)
      }
    } else {
      // 前台运行模式
      const child = spawn('node', [APP_FILE], {
        stdio: 'inherit'
      })

      console.log(`🔄 服务已启动 (PID: ${child.pid})`)

      this.writePid(child.pid)

      // 监听进程退出
      child.on('exit', (code, signal) => {
        this.removePidFile()
        if (code !== 0) {
          console.log(`💥 进程退出 (代码: ${code}, 信号: ${signal})`)
        }
      })

      child.on('error', (error) => {
        console.error('❌ 启动失败:', error.message)
        this.removePidFile()
      })
    }

    return true
  }

  stop() {
    const status = this.getStatus()
    if (!status.running) {
      console.log('⚠️  服务未在运行')
      this.removePidFile() // 清理可能存在的过期PID文件
      return false
    }

    console.log(`🛑 停止服务 (PID: ${status.pid})...`)

    try {
      // 优雅关闭：先发送SIGTERM
      process.kill(status.pid, 'SIGTERM')

      // 等待进程退出
      let attempts = 0
      const maxAttempts = 30 // 30秒超时

      const checkExit = setInterval(() => {
        attempts++
        if (!this.isProcessRunning(status.pid)) {
          clearInterval(checkExit)
          console.log('✅ 服务已停止')
          this.removePidFile()
          return
        }

        if (attempts >= maxAttempts) {
          clearInterval(checkExit)
          console.log('⚠️  优雅关闭超时，强制终止进程...')
          try {
            process.kill(status.pid, 'SIGKILL')
            console.log('✅ 服务已强制停止')
          } catch (error) {
            console.error('❌ 强制停止失败:', error.message)
          }
          this.removePidFile()
        }
      }, 1000)
    } catch (error) {
      console.error('❌ 停止服务失败:', error.message)
      this.removePidFile()
      return false
    }

    return true
  }

  restart(daemon = false) {
    console.log('🔄 重启服务...')
    this.stop()
    // 等待停止完成
    setTimeout(() => {
      this.start(daemon)
    }, 2000)

    return true
  }

  status() {
    const status = this.getStatus()
    if (status.running) {
      console.log(`✅ 服务正在运行 (PID: ${status.pid})`)

      // 显示进程信息
      exec(`ps -p ${status.pid} -o pid,ppid,pcpu,pmem,etime,cmd --no-headers`, (error, stdout) => {
        if (!error && stdout.trim()) {
          console.log('\n📊 进程信息:')
          console.log('PID\tPPID\tCPU%\tMEM%\tTIME\t\tCOMMAND')
          console.log(stdout.trim())
        }
      })
    } else {
      console.log('❌ 服务未运行')
    }
    return status.running
  }

  logs(lines = 50, follow = false) {
    if (follow) {
      console.log(`📖 实时查看日志 (Ctrl+C 退出):\n`)
      // 使用 tail -f 实时查看日志
      const tailProcess = spawn('tail', ['-f', LOG_FILE], {
        stdio: 'inherit'
      })

      // 处理 Ctrl+C
      process.on('SIGINT', () => {
        tailProcess.kill()
        console.log('\n\n✅ 已停止日志查看')
        process.exit(0)
      })
    } else {
      console.log(`📖 最近 ${lines} 行日志:\n`)

      exec(`tail -n ${lines} ${LOG_FILE}`, (error, stdout) => {
        if (error) {
          console.error('读取日志失败:', error.message)
          return
        }
        console.log(stdout)
      })
    }
  }

  help() {
    console.log(`
🔧 Claude Relay Service 进程管理器

用法: npm run service <command> [options]

重要提示：
  如果要传递参数，请在npm run命令中使用 -- 分隔符
  npm run service <command> -- [options]

命令:
  start [-d|--daemon]        启动服务 (-d: 后台运行)
  stop                       停止服务
  restart [-d|--daemon]      重启服务 (-d: 后台运行)
  status                     查看服务状态
  logs [lines] [-f|--follow] 查看日志 (默认50行, -f: 实时查看)
  help                       显示帮助信息

命令缩写:
  s, start              启动服务
  r, restart            重启服务
  st, status            查看状态
  l, log, logs          查看日志
  halt, stop            停止服务
  h, help               显示帮助

示例:
  npm run service start              # 前台启动
  npm run service -- start -d        # 后台启动（正确方式）
  npm run service:start:d            # 后台启动（推荐快捷方式）
  npm run service:daemon             # 后台启动（推荐快捷方式）
  npm run service stop               # 停止服务
  npm run service -- restart -d      # 后台重启（正确方式）
  npm run service:restart:d          # 后台重启（推荐快捷方式）
  npm run service status             # 查看状态
  npm run service logs               # 查看日志
  npm run service -- logs 100        # 查看最近100行日志
  npm run service:logs:follow        # 实时查看日志（推荐快捷方式）
  npm run service -- logs -f         # 实时查看日志

推荐的快捷方式（无需 -- 分隔符）:
  npm run service:start:d            # 等同于 npm run service -- start -d
  npm run service:restart:d          # 等同于 npm run service -- restart -d
  npm run service:daemon             # 等同于 npm run service -- start -d

直接使用脚本（推荐）:
  node scripts/manage.js start -d    # 后台启动
  node scripts/manage.js restart -d  # 后台重启
  node scripts/manage.js status      # 查看状态
  node scripts/manage.js logs 100    # 查看最近100行日志

文件位置:
  PID文件: ${PID_FILE}
  日志文件: ${LOG_FILE}
  错误日志: ${ERROR_LOG_FILE}
        `)
  }
}

// 主程序
function main() {
  const manager = new ServiceManager()
  const args = process.argv.slice(2)
  const command = args[0]
  const isDaemon = args.includes('-d') || args.includes('--daemon')

  switch (command) {
    case 'start':
    case 's':
      manager.start(isDaemon)
      break
    case 'stop':
    case 'halt':
      manager.stop()
      break
    case 'restart':
    case 'r':
      manager.restart(isDaemon)
      break
    case 'status':
    case 'st':
      manager.status()
      break
    case 'logs':
    case 'log':
    case 'l': {
      const follow = args.includes('-f') || args.includes('--follow')
      const linesArg = args.find(
        (arg) => !arg.startsWith('-') && arg !== 'logs' && arg !== 'log' && arg !== 'l'
      )
      const lines = parseInt(linesArg) || 50
      manager.logs(lines, follow)
      break
    }
    case 'help':
    case '--help':
    case '-h':
    case 'h':
      manager.help()
      break
    default:
      console.log('❌ 未知命令:', command)
      manager.help()
      process.exit(1)
  }
}

if (require.main === module) {
  main()
}

module.exports = ServiceManager
