// Docker smoke fixture only. Android's AOSP pairing server endpoint, bound to
// this build step's isolated loopback so no tablet or local network is used.
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cstring>
#include <fstream>
#include <future>
#include <iostream>
#include <iterator>
#include <memory>
#include <string>
#include <string_view>

#include <adb/pairing/pairing_connection.h>

static std::string ReadFile(const char* path) {
    std::ifstream file(path);
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}

int main(int argc, char** argv) {
    if (argc != 3) return 2;
    const auto cert = ReadFile(argv[1]);
    const auto key = ReadFile(argv[2]);
    if (cert.empty() || key.empty()) return 2;
    const int listener = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (listener == -1) return 2;
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    socklen_t length = sizeof(address);
    if (bind(listener, reinterpret_cast<sockaddr*>(&address), length) == -1 ||
        listen(listener, 1) == -1 ||
        getsockname(listener, reinterpret_cast<sockaddr*>(&address), &length) == -1) return 2;
    std::cout << ntohs(address.sin_port) << std::endl;
    const auto fd = accept4(listener, nullptr, nullptr, SOCK_CLOEXEC);
    close(listener);
    if (fd == -1) return 2;

    constexpr uint8_t code[] = {'0', '1', '2', '3', '4', '5'};
    constexpr char guid[] = "adb-CodyTest-123456";
    PeerInfo peer{};
    peer.type = ADB_DEVICE_GUID;
    std::memcpy(peer.data, guid, sizeof(guid));
    std::promise<int> result;
    auto status = result.get_future();
    const auto ctx = std::unique_ptr<PairingConnectionCtx, decltype(&pairing_connection_destroy)>(
        pairing_connection_server_new(code, sizeof(code), &peer,
                                      reinterpret_cast<const uint8_t*>(cert.data()), cert.size(),
                                      reinterpret_cast<const uint8_t*>(key.data()), key.size()),
        pairing_connection_destroy);
    if (!ctx || !pairing_connection_start(ctx.get(), fd, [](const PeerInfo* info, int, void* opaque) {
            // A correct code must authenticate the public key carrying our label.
            int outcome = 1;
            if (info) {
                const auto* data = reinterpret_cast<const char*>(info->data);
                const std::string_view public_key(data, strnlen(data, sizeof(info->data)));
                outcome = info->type == ADB_RSA_PUB_KEY && public_key.ends_with(" Cody@deadbeef") ? 0 : 2;
            }
            static_cast<std::promise<int>*>(opaque)->set_value(outcome);
        }, &result)) return 2;
    return status.get();
}
