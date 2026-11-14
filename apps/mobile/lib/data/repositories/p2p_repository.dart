import 'package:globalpay/data/api/api_client.dart';
import 'package:globalpay/data/api/generated/export.dart' as dto;
import 'package:globalpay/data/repositories/payments_repository.dart';
import 'package:globalpay/domain/models/p2p.dart';
import 'package:globalpay/domain/models/payment.dart';

/// Tap to pay (POST /p2p/requests, /tap, /claim, /approve, ...) and the phone's registration.
class P2pRepository {
  const P2pRepository({required this.api});

  final ApiClient api;

  /// Registers this phone's hardware key and push token; returns the device ID it announces when tapped.
  Future<String> registerDevice({required String publicKey, String? fcmToken}) async {
    final response = await ApiClient.call(
      () => api.api.p2p.registerDevice(
        body: dto.DeviceRegistration(publicKey: publicKey, platform: dto.DeviceRegistrationPlatform.android, fcmToken: fcmToken),
      ),
    );
    return response.id;
  }

  /// Stops the backend accepting taps from this device. Registering the same key again undoes it.
  Future<void> revokeDevice(String id) async {
    await ApiClient.call(() => api.api.p2p.revokeDevice(id: id));
  }

  /// Sets the name people see when paying you.
  Future<String> updateName(String name) async =>
      (await ApiClient.call(() => api.api.account.updateProfile(body: dto.ProfileUpdate(displayName: name)))).displayName;

  /// Receiver: ask for [units] USDC base units.
  Future<P2pRequest> create(BigInt units) =>
      _call(() => api.api.p2p.createPaymentRequest(body: dto.PaymentRequestCreate(amount: units.toString())));

  Future<P2pRequest> get(String id) => _call(() => api.api.p2p.getPaymentRequest(id: id));

  /// Receiver: forward what the other phone answered over NFC.
  Future<P2pRequest> tap(String id, {required String deviceId, required String signature}) =>
      _call(() => api.api.p2p.tapPaymentRequest(id: id, body: dto.TapAnswer(deviceId: deviceId, signature: signature)));

  /// Sender: claim a request from the receiver's QR.
  Future<P2pRequest> claim(String id, String challenge) =>
      _call(() => api.api.p2p.claimPaymentRequest(id: id, body: dto.ClaimRequest(challenge: challenge)));

  /// Requests I received or paid, newest first (the backend keeps the last 50).
  Future<List<P2pRequest>> list() async {
    final response = await ApiClient.call(() => api.api.p2p.listPaymentRequests());
    return response.requests.map(p2pRequestFromDto).toList();
  }

  /// Sender: requests waiting for my approval.
  Future<List<P2pRequest>> incoming() async {
    final response = await ApiClient.call(() => api.api.p2p.listIncomingRequests());
    return response.requests.map(p2pRequestFromDto).toList();
  }

  /// Sender: the eth_signTypedData_v4 payload of the USDC transfer, exactly as the backend will check it.
  Future<Map<String, Object?>> authorization(String id) async {
    final typed = await ApiClient.call(() => api.api.p2p.getPaymentRequestAuthorization(id: id));
    return {
      'types': {
        for (final entry in typed.types.entries)
          entry.key: [
            for (final field in entry.value) {'name': field.name, 'type': field.type},
          ],
      },
      // Null for a type this app doesn't know, which the signing check refuses.
      'primaryType': typed.primaryType.json,
      'domain': typed.domain.toJson(),
      'message': typed.message.toJson(),
    };
  }

  Future<P2pRequest> approve(String id, String signature) =>
      _call(() => api.api.p2p.approvePaymentRequest(id: id, body: dto.ApproveRequest(signature: signature)));

  Future<P2pRequest> decline(String id) => _call(() => api.api.p2p.declinePaymentRequest(id: id));

  Future<P2pRequest> cancel(String id) => _call(() => api.api.p2p.cancelPaymentRequest(id: id));

  Future<P2pRequest> _call(Future<dto.P2pRequest> Function() request) async => p2pRequestFromDto(await ApiClient.call(request));
}

P2pRequest p2pRequestFromDto(dto.P2pRequest response) => P2pRequest(
  id: response.id,
  isReceiver: response.role == dto.P2pRequestRole.receiver,
  status: P2pStatus.fromApi(response.status.toJson()),
  token: response.token,
  amount: usdc(response.amount),
  recipientName: response.recipient.name,
  recipientVerified: response.recipient.verified,
  recipientAddress: response.recipient.address,
  expiresAt: response.expiresAt,
  createdAt: response.createdAt,
  senderAddress: response.sender?.address,
  challenge: response.challenge,
  transaction: response.transaction == null ? null : TxLink(hash: response.transaction!.hash, url: response.transaction!.url),
  failureReason: response.failureReason,
);
