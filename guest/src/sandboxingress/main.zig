const std = @import("std");
const tcp_forwarder = @import("sandboxd").tcp_forwarder;

const log = std.log.scoped(.sandboxingress);

pub fn main(init: std.process.Init) !void {
    const args = try init.minimal.args.toSlice(init.arena.allocator());

    try tcp_forwarder.run("virtio-ingress", parseVsockPort(args), log);
}

fn parseVsockPort(args: []const [:0]const u8) ?u32 {
    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        if (std.mem.eql(u8, args[i], "--vsock-port") and i + 1 < args.len) {
            return std.fmt.parseInt(u32, args[i + 1], 10) catch null;
        }
    }
    return null;
}
