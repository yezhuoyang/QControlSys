package riscq.soc.sim

import spinal.core._
import spinal.core.sim._
import spinal.lib._
import riscq.soc.link.{EventLink, PutHub, PutLane, Put}
import riscq.soc.spec.SocSpecMap
import java.io.{File, PrintWriter}
import scala.collection.mutable.ArrayBuffer

/**
 * QuantumOS: the latency of the board-to-board put network, in dspClk cycles, on RISC-Q's own RTL — two
 * PutHubs (board 0 the barrier root) joined by two PutLanes (the White Rabbit TX/RX PCS pairs), as
 * RISC-Q's PutLaneSim builds them, but clocked as on the board: dspClk 500 MHz (2 ns), the lane's word
 * clock 62.5 MHz (16 ns: 20-bit words at 1.25 Gb/s, docs/wr/WrGtyPhy.md). The serial line between the two
 * PCSes is `lineWords` word clocks of delay (args(1)): the GTY transceivers' TX + RX latency and the
 * cable are not part of RISC-Q's RTL and are added by the caller from their own source.
 *
 *   mill runMain riscq.soc.sim.QosLaneTiming <output.json> [lineWords]
 * Output: { publish: {local, remote}, unicast: {remote}, barrier: {root, remote}, frameWords } in dspClk
 * cycles from the put entering the source hub.
 */
object QosLaneTiming extends App {
  val out = args(0)
  val lineWords = if (args.length > 1) args(1).toInt else 3
  val cores = 3
  case class Dut() extends Component {
    val refCd = ClockDomain.external("ref", config = ClockDomainConfig(resetKind = BOOT))
    val rxCd  = ClockDomain.external("rx", config = ClockDomainConfig(resetKind = BOOT))
    val hubs  = Seq(PutHub(cores = cores, board = 0, boards = 2), PutHub(cores = cores, board = 1, boards = 2))
    val lanes = Seq.fill(2)(PutLane(refCd, rxCd, clockDomain, calThreshLog2 = 8))
    val puts  = Vec(Vec(slave port Flow(Put(SocSpecMap.putAddrWidth)), cores), 2)
    val time  = Vec(in port UInt(32 bits), 2)
    val bcast = Vec(master port cloneOf(hubs(0).out), 2)
    for (i <- 0 until 2) {
      for (c <- 0 until cores) hubs(i).in(c) << puts(i)(c)
      hubs(i).time := time(i)
      bcast(i) << hubs(i).out
      lanes(i).putTx << hubs(i).laneOut
      hubs(i).laneIn << lanes(i).putRx
      lanes(i).hostTx.valid := False
      lanes(i).hostTx.payload.assignDontCare()
      lanes(i).hostRx.ready := True
      lanes(i).tx.pcs.io.calMode := False
    }
    val wire = rxCd { new Area {
      def cross(w: Bits): Bits = { val r = RegNext(w); r.addTag(crossClockDomain); Delay(r, lineWords - 1) }
      lanes(1).rx.pcs.io.rxDataRaw := cross(lanes(0).tx.pcs.io.txDataRaw)
      lanes(0).rx.pcs.io.rxDataRaw := cross(lanes(1).tx.pcs.io.txDataRaw)
    }}
  }
  SimConfig.addSimulatorFlag("-Wno-fatal").compile(Dut()).doSim("qosLane", seed = 5) { dut =>
    val cd = dut.clockDomain
    for (i <- 0 until 2; c <- 0 until cores) dut.puts(i)(c).valid #= false
    dut.time(0) #= 0; dut.time(1) #= 0
    cd.forkStimulus(2000)
    dut.refCd.forkStimulus(16000)
    fork { sleep(3000); dut.rxCd.forkStimulus(16000) }
    var t = 0L
    var cycle = 0L
    fork { while (true) { cd.waitSampling(); t += 1; cycle += 1; dut.time(0) #= t; dut.time(1) #= t } }
    val beats = Seq.fill(2)(ArrayBuffer[(Long, Int, Int)]())   // (cycle, mask, address)
    cd.onSamplings {
      for (i <- 0 until 2) if (dut.bcast(i).valid.toBoolean)
        beats(i) += ((cycle, dut.bcast(i).payload.mask.toInt, dut.bcast(i).payload.put.address.toInt))
    }
    def put(board: Int, core: Int, node: Int, offset: Int, data: Long): Long = {
      dut.puts(board)(core).valid #= true
      dut.puts(board)(core).payload.address #= (BigInt(node) << 16) + offset
      dut.puts(board)(core).payload.data #= data
      cd.waitSampling()
      val at = cycle
      dut.puts(board)(core).valid #= false
      at
    }
    def settle(): Unit = cd.waitSampling(4000)
    def first(board: Int, after: Long, addr: Int): Long =
      beats(board).find(b => b._1 >= after && b._2 != 0 && b._3 == addr).map(_._1 - after).getOrElse(-1L)
    cd.waitSampling(3000)   // the RX PCS locks on commas first
    // 1. a publish on board 1: its own broadcast, then board 0's (over the lane).
    val p = put(1, 0, SocSpecMap.groupNode(0), 0, (5 << 1) | 1); settle()
    val pubLocal = first(1, p, EventLink.boardOffset); val pubRemote = first(0, p, EventLink.boardOffset)
    // 2. a unicast from board 0 to a core on board 1.
    val u = put(0, 1, SocSpecMap.inboxNode(1, 2), EventLink.mailboxOffset(0), 0x77L); settle()
    val uniRemote = first(1, u, EventLink.mailboxOffset(0))
    // 3. a barrier: one member on board 0 arrives first, the last arrives on board 1.
    put(0, 0, SocSpecMap.barrierNode(3), 0, 2); cd.waitSampling(200)
    val b = put(1, 2, SocSpecMap.barrierNode(3), 0, 2); settle()
    val barRoot = first(0, b, EventLink.releaseOffset); val barRemote = first(1, b, EventLink.releaseOffset)
    val pw = new PrintWriter(new File(out))
    pw.print(s"""{"lineWords":$lineWords,"dspPs":2000,"wordPs":16000,"publish":{"local":$pubLocal,"remote":$pubRemote},""" +
      s""""unicast":{"remote":$uniRemote},"barrier":{"root":$barRoot,"remote":$barRemote}}""")
    pw.close()
    println(s"[QosLaneTiming] publish local $pubLocal remote $pubRemote; unicast remote $uniRemote; barrier root $barRoot remote $barRemote (dspClk cycles)")
    simSuccess()
  }
}
