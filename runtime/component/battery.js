var logger = require('logger')('battery')

/** ordered by priority */
var lowPowerWaterMarks = [
  {
    level: 8,
    /** proactively push low power notifications but doesn't announce */
    proactive: () => true,
    preempt: () => false
  },
  {
    level: 10,
    /** proactively announce low power if not idle */
    proactive: idle => !idle,
    preempt: idle => !idle
  },
  {
    level: 20,
    /** lazily announce low power */
    proactive: () => false
  }
]

class Battery {
  constructor (runtime) {
    this.runtime = runtime
    this.component = runtime.component

    this.batSupported = false
    this.memoInfo = null

    this.lastDangerousAnnounceTimeStamp = null
    this.dangerousState = 'normal'

    this.shouldAnnounceLowPower = false
  }

  init () {
    this.component.flora.subscribe('battery.info', this.handleFloraInfo.bind(this))
  }

  handleFloraInfo (caps) {
    var msg = caps[0]
    var data
    try {
      data = JSON.parse(msg)
    } catch (err) {
      logger.error('Invalid data received from "battery.info".')
      return
    }
    if (!data.batSupported) {
      return
    }
    this.batSupported = true

    if (!data.batChargingOnline && data.batLevel <= 5) {
      return this.runtime.openUrl('yoda-app://system/shutdown')
    }

    switch (true) {
      case data.batTemp >= 55:
        this.dangerousState = 'high'
        this.runtime.openUrl('yoda-skill://battery/temperature_light_55', { preemptive: false })
        break
      case data.batTemp <= 0:
        this.dangerousState = 'low'
        this.runtime.openUrl('yoda-skill://battery/temperature_light_0', { preemptive: false })
        break
      default:
        this.dangerousState = 'normal'
    }

    if (this.memoInfo == null) {
      this.memoInfo = data
      return
    }

    var idle = this.component.visibility.getKeyAndVisibleAppId() == null

    for (var markIdx in lowPowerWaterMarks) {
      var option = lowPowerWaterMarks[markIdx]
      var mark = option.level
      if (this.memoInfo.batLevel <= mark || data.batLevel > mark) {
        continue
      }
      if (option.proactive(idle)) {
        logger.info(`proactive low power level water mark ${mark} applied`)
        this.shouldAnnounceLowPower = false
        this.runtime.openUrl(`yoda-skill://battery/low_power_${mark}?is_play=${!idle}`, { preemptive: option.preempt(idle) })
        break
      }
      logger.info(`low power level water mark ${mark} applied`)
      this.shouldAnnounceLowPower = true
      break
    }

    if (this.memoInfo.batChargingOnline !== data.batChargingOnline) {
      if (data.batChargingOnline) {
        this.runtime.openUrl(`yoda-skill://battery/power_on?is_play=${!idle}`, { preemptive: idle })
      } else {
        this.runtime.openUrl(`yoda-skill://battery/power_off?is_play=${!idle}`, { preemptive: idle })
      }
    }
    this.memoInfo = data
  }

  getWormholeResponse () {
    if (!this.batSupported) {
      return { hasBattery: false }
    }
    return {
      isAcConnected: this.memoInfo.batChargingOnline,
      batteryTemperature: this.memoInfo.batTemp,
      percent: this.memoInfo.batLevel,
      hasBattery: true
    }
  }

  isCharging () {
    logger.info('is charging?', this.batSupported, this.memoInfo)
    if (this.memoInfo == null) {
      return false
    }
    if (!this.batSupported) {
      return false
    }
    if (!this.memoInfo.batChargingOnline) {
      return false
    }
    return true
  }

  getBatteryLevel () {
    if (this.memoInfo == null) {
      return 0
    }
    if (!this.batSupported) {
      return 0
    }
    if (typeof this.memoInfo.batLevel !== 'number') {
      return 0
    }
    return this.memoInfo.batLevel
  }

  // MARK: - Interceptions
  delegateWakeUpIfDangerousStatus () {
    if (this.memoInfo == null) {
      return false
    }
    if (!this.batSupported) {
      return false
    }
    if (this.dangerousState === 'normal') {
      return false
    }
    var now = Date.now()
    if (this.lastDangerousAnnounceTimeStamp && (now - this.lastDangerousAnnounceTimeStamp) < 10 * 60 * 1000) {
      logger.info(`announced in 10 minutes, skip wakeup delegation`)
      return false
    }
    // TODO: close picking up
    this.lastDangerousAnnounceTimeStamp = now

    var url
    switch (this.dangerousState) {
      case 'high':
        url = 'yoda-skill://battery/temperature_55'
        break
      case 'low':
        url = 'yoda-skill://battery/temperature_0'
        break
      default:
        return false
    }
    return this.runtime.openUrl(url)
      .then(() => true)
  }

  delegateWakeUpIfBatteryInsufficient () {
    if (this.memoInfo == null) {
      return false
    }
    if (!this.batSupported) {
      return false
    }
    if (!this.shouldAnnounceLowPower) {
      return false
    }
    if (this.memoInfo.batChargingOnline) {
      logger.info(`battery is charging, skip wakeup delegation`)
      return false
    }
    // TODO: close picking up
    this.shouldAnnounceLowPower = false
    var idle = this.component.visibility.getKeyAndVisibleAppId() == null

    for (var markIdx in lowPowerWaterMarks) {
      var mark = lowPowerWaterMarks[markIdx].level
      if (this.memoInfo.batLevel <= mark) {
        return this.runtime.openUrl(`yoda-skill://battery/low_power_${mark}?is_play=${!idle}`)
          .then(() => true)
      }
    }
  }
  // MARK: - END Interceptions
}

module.exports = Battery