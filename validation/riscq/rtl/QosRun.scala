package riscq.soc.sim

import spinal.core._
import spinal.core.sim._
import spinal.lib.bus.amba4.axi.sim.Axi4Master
import riscq.soc.PulseTableSoc
import riscq.soc.spec.SocSpec
import riscq.riscv.regfile.RegFilePlugin
import riscq.riscv.fetch.FetchPlugin
import riscq.riscv.execute.LsuPlugin
import java.io.{File, PrintWriter}
import scala.collection.mutable.ArrayBuffer

/**
 * QuantumOS ground-truth run: execute a QuantumOS SoC program (the document `riscq/soc.mjs program()`
 * hands to the Lean model) on RISC-Q's own RTL, `PulseTableSoc`, in Verilator.
 *
 * Input JSON (written by QuantumOS `riscq/rtl.mjs`):
 *   { "spec": <RISC-Q channel-list SocSpec JSON>, "images": [[word, ...], ...], "cycles": N,
 *     "commits": true|false, "commitLimit": M }
 * Output JSON:
 *   { "resetReleaseCycle", "commits": [[core, cycle, time, pc, instr], ...],
 *     "pulses": [[core, channel, openCycle, openTime, closeCycle, closeTime], ...],
 *     "host": [[core, cycle, time, address, data, mask], ...], "done": [[core, cycle, time], ...] }
 * `cycle` counts dspClk cycles from the release of the cores' reset; `time` is the batch-time
 * register the cores read (`riscqArea.time`). The images are loaded over the host AXI port while the
 * cores are held in reset, exactly as RISC-Q's own CPU-in-the-loop sims and its board software do.
 *
 * Copied into RISC-Q's `src/riscq/soc/sim/` by `riscq/rtl.mjs` and run with
 *   mill runMain riscq.soc.sim.QosRun <input.json> <output.json>
 */
object QosRun extends App {
  require(args.length >= 2 && args.length % 2 == 0, "usage: QosRun <input.json> <output.json> [<input.json> <output.json> ...]")
  // Several programs on one build: the spec of the first input is compiled once; every other input
  // must state the same spec.
  val jobs = args.grouped(2).map { case Array(i, o) => (ujson.read(scala.io.Source.fromFile(i).mkString), o) }.toList
  val specJson = ujson.write(jobs.head._1("spec"))
  for ((input, _) <- jobs) require(ujson.write(input("spec")) == specJson, "every input must state the same spec")
  val spec = SocSpec.fromJson(specJson)

  val workspace = sys.env.getOrElse("QOS_RTL_WORKSPACE", "simWorkspace")
  val compiled = SimConfig.workspacePath(workspace)
    .addSimulatorFlag("-Wno-MULTIDRIVEN").addSimulatorFlag("-Wno-fatal").addSimulatorFlag("--x-initial 0")
    .compile {
      val dut = new PulseTableSoc(spec, withTest = false)
      dut.riscqArea.time.simPublic()
      for (c <- dut.riscqArea.riscqCores) {
        c.riscvSoc.hostCmd.valid.simPublic(); c.riscvSoc.hostCmd.ready.simPublic(); c.riscvSoc.hostCmd.payload.simPublic()
        c.riscvSoc.done.simPublic()
        for (ch <- c.posted.channels; out <- ch.dacOut) out.valid.simPublic()
        c.riscvSoc.cmd.valid.simPublic()
        c.xput.valid.simPublic(); c.hubIn.valid.simPublic(); c.riscvSoc.resultIn.valid.simPublic()
      }
      dut.riscqArea.hub.out.valid.simPublic(); dut.riscqArea.hub.out.payload.mask.simPublic()
      dut
    }

  for (((input, outPath), job) <- jobs.zipWithIndex) {
  val images      = input("images").arr.map(_.arr.map(v => BigInt(v.num.toLong) & 0xFFFFFFFFL).toArray).toArray
  val cycles      = input("cycles").num.toLong
  val withCommits = input.obj.get("commits").exists(_.bool)
  val commitLimit = input.obj.get("commitLimit").map(_.num.toInt).getOrElse(2000000)
  // `probe`: cycles of per-cycle fetch handshakes to record for core 0 (instruction-bus request
  // valid/ready, response valid, and the fetch join firing), to see where fetch bubbles come from.
  val probeCycles = input.obj.get("probe").map(_.num.toInt).getOrElse(0)
  require(images.length == spec.cores.length, s"${images.length} images for ${spec.cores.length} cores")
  compiled.doSim("qosRun" + job, seed = 1) { dut =>
    val hostCd = dut.clockDomain
    val dspCd  = dut.dspCd
    dut.io.axi.ar.valid #= false; dut.io.axi.aw.valid #= false; dut.io.axi.w.valid #= false
    dut.io.axi.r.ready #= false;  dut.io.axi.b.ready #= false
    for (i <- 0 until dut.io.adc.length) { dut.io.adc(i).valid #= true; dut.io.adc(i).payload #= 0 }
    hostCd.forkStimulus(10)
    dspCd.forkStimulus(10)
    // The PS DDR behind the host window (S_AXI_HP0_FPD): RISC-Q's own model, made always ready so the
    // run is deterministic. A stalling DDR port would only back-pressure host-window stores.
    val hostMem = HostMemModel(dut.io.hostMem, hostCd)
    hostMem.awReady.setFactor(1.0f); hostMem.wReady.setFactor(1.0f)
    hostCd.waitSampling(40)
    val axi = Axi4Master(dut.io.axi, hostCd)
    def leBytes(v: BigInt, n: Int): List[Byte] = List.tabulate(n)(i => ((v >> (8 * i)) & 0xFF).toByte)
    val hostCtrlAddr = BigInt(dut.map.hostCtrlBase)
    // Hold the cores in reset BEFORE loading (RISC-Q's own setup order, HostWindowCpuSim): the reset
    // powers up deasserted, so the cores would otherwise already run the RAM's zero words.
    axi.write(hostCtrlAddr, List(0x01, 0x00, 0x00, 0x00).map(_.toByte))
    // Load each image in 64-byte bursts (16 words).
    for ((image, core) <- images.zipWithIndex) {
      val base = BigInt(dut.map.coreMemOffset(core))
      for (start <- image.indices by 16) {
        val chunk = image.slice(start, start + 16)
        axi.write(base + start.toLong * 4, chunk.toList.flatMap(w => leBytes(w, 4)))
      }
    }
    // The host window: base address and enable (HOSTWIN_BASE_LO at +72, HOSTWIN_BASE_HI with bit 31 =
    // enable at +76), programmed while reset is held, as HostWindowCpuSim does.
    val hostWinBase = BigInt("800000000", 16)
    axi.write(hostCtrlAddr + 72, leBytes(hostWinBase & 0xFFFFFFFFL, 4))
    axi.write(hostCtrlAddr + 76, leBytes((hostWinBase >> 32) | (BigInt(1) << 31), 4))
    hostCd.waitSampling(200)

    val cores = dut.riscqArea.riscqCores
    val rf = cores.map(c => c.riscvSoc.riscqFiber.riscq.host[RegFilePlugin].logic.exec)
    val outs = cores.map(c => c.posted.channels.map(_.dacOut))
    val commits = ArrayBuffer[String]()
    val pulses = ArrayBuffer[String]()
    val host = ArrayBuffer[String]()
    val done = ArrayBuffer[String]()
    // Hub traffic: [cycle, kind, core]. kind 0 = a system put leaves the core's link for the hub,
    // 1 = the hub dispatches a beat (core = destination mask), 2 = a beat reaches the core's up-link
    // merge, 3 = the core's inbox (resultIn) takes an up-link beat.
    val hubEvents = ArrayBuffer[String]()
    val probe = ArrayBuffer[String]()
    val fetch0 = cores(0).riscvSoc.riscqFiber.riscq.host[FetchPlugin].logic
    val tl0 = cores(0).riscvSoc.riscqFiber.dBus.bus.get
    val open = Array.tabulate(cores.length)(c => Array.fill(outs(c).length)(-1L))
    val openTime = Array.tabulate(cores.length)(c => Array.fill(outs(c).length)(-1L))
    val doneSeen = Array.fill(cores.length)(false)
    var released = false
    var cycle = 0L
    dspCd.onSamplings {
      if (released) {
        val time = dut.riscqArea.time.toBigInt.toLong
        if (cycle < probeCycles) {
          val ib = fetch0.iBus
          def b(x: Bool) = if (x.toBoolean) 1 else 0
          val row = Seq(cycle, b(ib.a.valid), b(ib.a.ready), b(ib.d.valid), b(fetch0.join.dbgFiring), ib.a.source.toInt, ib.d.source.toInt,
            0, 0, 0, b(tl0.a.valid), b(tl0.a.ready), b(tl0.d.valid),
            b(cores(0).riscvSoc.cmd.valid), b(cores(0).riscvSoc.hostCmd.valid))
          probe += row.mkString("[", ",", "]")
        }
        if (dut.riscqArea.hub.out.valid.toBoolean) hubEvents += s"[$cycle,1,${dut.riscqArea.hub.out.payload.mask.toBigInt}]"
        for (c <- cores.indices) {
          if (cores(c).xput.valid.toBoolean) hubEvents += s"[$cycle,0,$c]"
          if (cores(c).hubIn.valid.toBoolean) hubEvents += s"[$cycle,2,$c]"
          if (cores(c).riscvSoc.resultIn.valid.toBoolean) hubEvents += s"[$cycle,3,$c]"
          if (withCommits && commits.length < commitLimit && rf(c).dbgFiring.toBoolean)
            commits += s"[$c,$cycle,$time,${rf(c).dbgPc.toBigInt},${rf(c).dbgInstr.toBigInt}]"
          val hc = cores(c).riscvSoc.hostCmd
          if (hc.valid.toBoolean && hc.ready.toBoolean) {
            val p = hc.payload
            host += s"[$c,$cycle,$time,${p.offset.toBigInt},${p.data.toBigInt},${p.strb.toBigInt}]"
          }
          if (!doneSeen(c) && cores(c).riscvSoc.done.toBoolean) { doneSeen(c) = true; done += s"[$c,$cycle,$time]" }
          for ((o, k) <- outs(c).zipWithIndex; f <- o) {
            val v = f.valid.toBoolean
            if (v && open(c)(k) < 0) { open(c)(k) = cycle; openTime(c)(k) = time }
            if (!v && open(c)(k) >= 0) {
              pulses += s"[$c,$k,${open(c)(k)},${openTime(c)(k)},$cycle,$time]"
              open(c)(k) = -1
            }
          }
        }
        cycle += 1
      }
    }
    axi.write(hostCtrlAddr, List(0x00, 0x00, 0x00, 0x00).map(_.toByte))
    // The write's last beat releases the reset; count from the next dspClk edge.
    released = true
    dspCd.waitSampling(cycles.toInt)
    val out = new PrintWriter(new File(outPath))
    out.print(s"""{"cycles":$cycle,"commits":[${commits.mkString(",")}],"pulses":[${pulses.mkString(",")}],""" +
      s""""host":[${host.mkString(",")}],"done":[${done.mkString(",")}],"probe":[${probe.mkString(",")}],"hub":[${hubEvents.mkString(",")}]}""")
    out.close()
    println(s"[QosRun] $cycle cycles, ${commits.length} commits, ${pulses.length} pulses, ${host.length} host writes")
    simSuccess()
  }
  }
}
