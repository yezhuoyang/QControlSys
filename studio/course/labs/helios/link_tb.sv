`timescale 1ns/1ps
module link_tb;
  reg clk=0, reset=0, initialize=0;
  reg a_inc=0,b_inc=0,a_odd=0,b_odd=0;
  reg [14:0] a_root=0,b_root=0;
  wire full,odd;
  wire [14:0] a_out,b_out;
  neighbor_link dut(.clk(clk),.reset(reset),.initialize(initialize),
    .a_increase(a_inc),.b_increase(b_inc),.a_is_odd_cluster(a_odd),.b_is_odd_cluster(b_odd),
    .a_old_root_in(a_root),.b_old_root_in(b_root),.a_old_root_out(a_out),.b_old_root_out(b_out),
    .is_fully_grown(full),.is_odd_cluster(odd));
  task tick;
    #5 clk=1;
    #1 $display("%0d %0d %0d %0d %0d",dut.increased,full,odd,a_out,b_out);
    #4 clk=0;
  endtask
  initial begin
    reset=1; tick();
    reset=0; a_inc=1; a_root=3; b_root=9; tick();
    a_inc=0; a_root=0; b_root=0; b_inc=1; a_odd=1; tick();
    b_inc=0; tick();
    a_odd=0; initialize=1; tick();
    $finish;
  end
endmodule
