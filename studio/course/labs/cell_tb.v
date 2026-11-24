`timescale 1ns/1ps
module cell_tb;
  reg clk = 0;
  reg [1:0] pins = 0;
  wire q;
  integer i;
  cell_demo dut(.clk(clk), .a(pins[0]), .b(pins[1]), .q(q));
  initial begin
    if (q !== 0) $fatal(1, "initial Q");
    for (i = 0; i < 4; i = i + 1) begin
      clk = 0;
      pins = i;
      #5 clk = 1;
      #1 if (q !== (^pins)) $fatal(1, "capture");
      pins[0] = !pins[0];
      #4 if (q === (^pins)) $fatal(1, "hold");
    end
    $display("All four capture and hold checks passed.");
    $finish;
  end
endmodule
