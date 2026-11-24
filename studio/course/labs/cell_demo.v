module cell_demo #(parameter [3:0] TABLE = 4'b0110)
  (input wire clk, a, b, output reg q = 0);
  wire d = TABLE[{b,a}];
  always @(posedge clk) q <= d;
endmodule
