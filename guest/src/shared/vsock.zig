const std = @import("std");
const posix = @import("posix_compat.zig");

const c = @cImport({
    @cInclude("sys/socket.h");
    @cInclude("linux/vm_sockets.h");
    @cInclude("unistd.h");
});

pub const HOST_CID: u32 = 2;

pub fn connectToHost(port: u32) !posix.fd_t {
    const fd = c.socket(c.AF_VSOCK, c.SOCK_STREAM, 0);
    if (fd < 0) return error.VsockSocketFailed;
    errdefer _ = c.close(fd);

    var addr = std.mem.zeroes(c.struct_sockaddr_vm);
    addr.svm_family = c.AF_VSOCK;
    addr.svm_port = port;
    addr.svm_cid = HOST_CID;

    const sockaddr_ptr: *const c.struct_sockaddr = @ptrCast(&addr);
    const addr_len: c.socklen_t = @intCast(@sizeOf(c.struct_sockaddr_vm));

    if (c.connect(fd, sockaddr_ptr, addr_len) != 0) {
        return error.VsockConnectFailed;
    }

    return fd;
}
