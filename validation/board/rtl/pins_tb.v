`timescale 1ns/1ps
// Observe the published dio24_timing module at its package-output registers.
// This pad-timing test supplies the FIFO/CDC boundary values explicitly.
module pins_tb;
  reg clk = 0, reset_n = 0, run = 0;
  always #10 clk = !clk;
  wire [15:0] data;
  wire [6:0] address;
  wire strobe;
  reg [64:0] image [0:3];
  integer index = 0;
  wire [64:0] head = index < 4 ? image[index] : 65'd0;
  wire valid = index < 4;
  dio24_timing dut(.clock_slow(clk), .clock_fast(clk),
    .reset_n_slow(reset_n), .reset_n_fast(reset_n), .reset_FIFO(!reset_n),
    .ctrl_bits({6'b0,run}), .test_bits(10'd0), .num_samples(32'd4),
    .trg_delay(32'd0), .ctrl_regs_reload(1'b0), .trg_start(1'b0), .trg_stop(1'b0),
    .in_data(65'd0), .in_valid(1'b0), .out_ready(1'b1), .irq_TX(1'b0), .irq_RX(1'b0),
    .bus_data(data), .bus_addr(address), .bus_strb(strobe));

  initial begin
    $readmemh("program.hex", image);
    force dut.next_data = head;
    force dut.next_valid = valid;
    force dut.out_ready_s = 1'b1;
    force dut.s_num_samples = 32'd4;
    force dut.s_trg_delay_out = 0;
    force dut.s_trg_delay_in = 0;
    repeat (3) @(negedge clk);
    reset_n = 1;
    repeat (3) @(negedge clk);
    run = 1;
  end
  always @(posedge clk) if (reset_n && dut.next_ready && valid) index <= index+1;

  reg [23:0] previous = 0;
  always @(negedge clk) begin
    if (reset_n && {address,data,strobe} !== previous) begin
      if (^{address,data,strobe} === 1'bx) $fatal(1,"Unknown pin state");
      $display("PINS %0d %0d %0d %0d", $time, address, $signed(data), strobe);
      previous = {address,data,strobe};
    end
    if (reset_n && dut.state_end && index == 4) begin
      $display("COMPLETED");
      $finish;
    end
    if ($time > 25000) $fatal(1,"Timing core did not retire all four records");
  end
endmodule
