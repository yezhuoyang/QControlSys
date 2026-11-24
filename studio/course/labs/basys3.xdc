# Digilent Basys 3 rev B. Distances and pin assignments are board specific.
set_property -dict {PACKAGE_PIN W5 IOSTANDARD LVCMOS33} [get_ports clk]
create_clock -name board_clock -period 10.0 [get_ports clk]
set_property -dict {PACKAGE_PIN V17 IOSTANDARD LVCMOS33} [get_ports a]
set_property -dict {PACKAGE_PIN V16 IOSTANDARD LVCMOS33} [get_ports b]
set_property -dict {PACKAGE_PIN U16 IOSTANDARD LVCMOS33} [get_ports q]
