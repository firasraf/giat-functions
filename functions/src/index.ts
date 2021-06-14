import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { DocumentSnapshot, snapshotConstructor } from "firebase-functions/lib/providers/firestore";
import { eventarc_v1, google } from 'googleapis';
import https from 'https';
import { docs } from "googleapis/build/src/apis/docs";

// // Start writing Firebase Functions
// // https://firebase.google.com/docs/functions/typescript
//
// export const helloWorld = functions.https.onRequest((request, response) => {
//   functions.logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

const PROJECT_ID = 'giatantar';
const HOST = 'fcm.googleapis.com';
const PATH = '/v1/projects/' + PROJECT_ID + '/messages:send';
const MESSAGING_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const SCOPES = [MESSAGING_SCOPE];

let db: FirebaseFirestore.Firestore;
let messaging: admin.messaging.Messaging;
let initialized = false;

function initialize() {
  if (initialized === true) return;
  initialized = true;
  admin.initializeApp();
  messaging = admin.messaging();
  db = admin.firestore();
}


function getStatusOrderFromNotification(status: String) {
  var statusBody;
  switch (status) {
    case "DRIVER_TERIMA": {
      statusBody = "Driver Sudah Menerima Pesanan Anda. Menuju Tempat Penjual"
      break;
    }
    case "MERCHANT_PROSES": {
      statusBody = "Penjual sudah menerima pesanan"
      break;
    }
    case "DRIVER_AMBIL": {
      statusBody = "Mengambil Pesanan di Penjual"
      break;
    }
    case "DRIVER_ANTAR": {
      statusBody = "Pesanan Selesai. Menuju ke Destinasi Anda";
      break;
    }
    case "DRIVER_SELESAI": {
      statusBody = "Terima kasih telah bersama GIAT. Enjoy your food!";
      break;
    }
    default: {
      break;
    }
  }
  return statusBody;
}

async function processFeeUpdateOrder(driverId: string, snap: DocumentSnapshot) {

  const currentDriver = await db
    .collection("userdriver")
    .doc(driverId)
    .get();

  const representativeInternal = await db.collection("giatrepresentative").doc('Fdn55g42wzLreqb43aV9').get();

  const currentBalance = currentDriver.get("balance");

  const subTotal = snap.get("subTotal");
  const ongkosKirim = snap.get("biayaKirim");

  var quantityTotal;

  snap.get("pesanan").map(element => {
    functions.logger.info(element);
    var quantityItem = element['jumlah'] * 1000;
    var hargaItem = element['hargaMakanan'];
    quantityTotal = hargaItem - quantityItem;
  });

  const merchantFee = subTotal - quantityTotal;
  const dividedFee = merchantFee * 0.5;
  functions.logger.info("Divided Fee", dividedFee);
  const driverFee = ongkosKirim * 0.75;

  const giatRevenue = (ongkosKirim * 0.25) + dividedFee;

  functions.logger.info("GIAT Revenue Added: ", giatRevenue);
  functions.logger.info("Merchant Fee Total", merchantFee);
  functions.logger.info("Driver Total Fee ", driverFee);

  const updateInternal = {
    totalDriverFee: representativeInternal.data()['totalDriverFee'] + driverFee,
    totalMerchantFee: representativeInternal.data()['totalMerchantFee'] + dividedFee,
    transactionalRevenue: representativeInternal.data()['transactionalRevenue'] + (subTotal + ongkosKirim),
    transactions: representativeInternal.data()['transactions'] + 1,
    giatRevenue: representativeInternal.data()['giatRevenue'] + giatRevenue,
  }

  // parse
  const driverCurrentBalance = (currentBalance - (driverFee + dividedFee) | 0)
  functions.logger.info("Driver BALANCE FOR NOW: ", driverCurrentBalance);

  const update = {
    balance: driverCurrentBalance,
  };
  
  await db.runTransaction((transaction) => {
    transaction.update(currentDriver.ref, update);
    functions.logger.info("BALANCE CUTTING FOR DRIVER ", driverFee);
    return Promise.resolve();
  });

  await db.runTransaction((transaction) => {
    transaction.update(representativeInternal.ref, updateInternal);
    functions.logger.info("UPDATE REVENUE INTERNAL ");
    return Promise.resolve();
  });
}

async function processUpdateOrder(
    driverId: string,
  snap: DocumentSnapshot,
  context: functions.EventContext
) {
  const currentDriver = await db
    .collection("userdriver")
    .doc(driverId)
    .get();

  const representativeInternal = await db.collection("giatrepresentative").doc('Fdn55g42wzLreqb43aV9').get();

  const currentBalance = currentDriver.get("balance");

  const subTotalOrder = snap.get("subTotal");
  const ongkosKirim = snap.get("biayaKirim");

  // functions.logger.info("Merchant Fee Total", quantityTotal);

  const merchantFee = subTotalOrder * 0.3;
  const driverFee = ongkosKirim * 0.25;

  // const driverRevenueFee = quantityTotal + driverFee;

  // functions.logger.info("Driver Total Fee ", driverRevenueFee);

  const fee = subTotalOrder - 1000;

  const totalFee = currentBalance - (merchantFee + driverFee);

  const update = {
    balance: currentBalance - (merchantFee + driverFee),
  };

  const updateInternal = {
    totalDriverFee: representativeInternal.data()['totalDriverFee'] + driverFee,
    totalMerchantFee: representativeInternal.data()['totalMerchantFee'] + merchantFee,
    transactionalRevenue: representativeInternal.data()['transactionalRevenue'] + (subTotalOrder + ongkosKirim),
  }

  await db.runTransaction((transaction) => {
    transaction.update(currentDriver.ref, update);
    functions.logger.info("BALANCE CUTTING FOR DRIVER ", totalFee);
    return Promise.resolve();
  });

  await db.runTransaction((transaction) => {
    transaction.update(representativeInternal.ref, updateInternal);
    functions.logger.info("UPDATE REVENUE INTERNAL ");
    return Promise.resolve();
  });
}

async function pushNotificationToDriver(snapDriver: DocumentSnapshot, snap: DocumentSnapshot, context: functions.EventContext) {

  const gotToken = snapDriver.get("token");

  const testingPayload = {
    token: gotToken,
    data: {
      via: "GIAT Antar FCM",
      orderID: snap.id,
      customer_id: snap.data()["customer_id"],
      merchant_id: snap.data()["resto_id"],
      type_key: "ORDER_ONBOARDING",
      order_type: "ORDER_FOOD",
      count: "1",
    },
    notification: {
      title: 'GIAT Driver!',
      body: 'Ada Pesanan Siap Driver!',
    },
    android: {
      priority: "high" as const,
      ttl: 0,
      notification: {
        priority: "high" as const,
        visibility: "public" as const,
        clickAction: 'android.intent.action.MAIN',
        ticker: 'false',
      },
    },
  };

  messaging
  .send(testingPayload)
  .then((responsePayload) => {
    // Response is a message ID string.
    functions.logger.info("Successfully sent message:", responsePayload);
    // console.log('Successfully sent message:', response);
  })
  .catch((error) => {
    console.log("Error sending message:", error);
  });
}

async function pushNotificationToCustomer(snap: DocumentSnapshot, context: functions.EventContext) {
    const currentPengguna = await db.collection('userpengguna').doc(snap.data()["customer_id"]).get();
    const customerOrder = await db.collection('userpengguna').doc(snap.data()["customer_id"]).collection('Order').doc(snap.data()["unique_id"]).get();
    const gotToken = currentPengguna.get("token");
    const getStatusBody = getStatusOrderFromNotification(snap.data()['statusPesanan']);

    const updatePesanan = {
      statusPesanan: customerOrder.data()['statusPesanan'],
    };

    await db.runTransaction((transaction) => {
      transaction.update(customerOrder.ref,  updatePesanan);
      // transaction.set(currentPengguna.ref, { lagiPesanan: true });
      return Promise.resolve();
    })

    const testingPayload = {
        token: gotToken,
        data: {
          via: "GIAT Antar FCM",
          orderID: snap.id,
          customer_id: currentPengguna.id,
          merchant_id: snap.data()["resto_id"],
          type_key: "ORDER_ONBOARDING",
          order_type: "ORDER_FOOD",
          count: "1",
        },
        notification: {
          title: "GIAT!",
          body: getStatusBody,
        },
        android: {
          priority: "high" as const,
          ttl: 0,
          notification: {
            priority: "high" as const,
            visibility: "public" as const,
            clickAction: 'android.intent.action.MAIN',
            ticker: 'false',
          },
        },
      };


      messaging
      .send(testingPayload)
      .then((responsePayload) => {
        // Response is a message ID string.
        functions.logger.info("Successfully sent message:", responsePayload);
        // console.log('Successfully sent message:', response);
      })
      .catch((error) => {
        console.log("Error sending message:", error);
      });
}



export const updateMerchantOrder = functions.region("asia-southeast2").firestore
    .document("/usersresto/{restoId}/Order/{orderId}")
    .onUpdate(async (snapshot, context) => {
    initialize();
    if (snapshot.after.data()["statusPesanan"] == "MERCHANT_PROSES") {
        await pushNotificationToCustomer(snapshot.after, context);
    } else {
        return;
    }
})

/*
enum StatusPesanan {
  TERDAFTAR,
  MERCHANT_TERIMA,
  DRIVER_TERIMA,
  MERCHANT_PROSES,
  DRIVER_AMBIL,
  DRIVER_ANTAR,
  DRIVER_SELESAI,
}
*/

async function findDeliveryOrder(snap: DocumentSnapshot, context: functions.EventContext) {
  const currentSender = await db.collection("userpengguna").doc(snap.data()["customer_id"]).get();

  const lat = 0.0144927536231884;
  const lon = 0.0181818181818182;

  const lowerLat = currentSender.get('latitude') - (lat * 2);
  const lowerLon = currentSender.get('longitude') - (lon * 2);

  const greaterLat = currentSender.get('latitude') + (lat * 2);
  const greaterLon = currentSender.get('longitude') + (lon * 2);

  const lesserGeopoint = {
    latitude: lowerLat,
    longitude: lowerLon,
  }

  const greaterGeopoint = {
    latitude: greaterLat,
    longitude: greaterLon,
  }

  const luckyDriver = await db.collection("userdriver").where("statusAktif", "==", true).where("pinLocation", ">=", lesserGeopoint).where("pinLocation", "<=", greaterGeopoint).get();

  if (luckyDriver.docs.length == 0) {
    const updatePesanan = {
      statusPesanan: "TIDAK_ADA_DRIVER UNTUK DELIVERY",
    };
    
    await db.runTransaction((transaction) => {
      transaction.update(snap.ref, updatePesanan);
      // transaction.set(currentPengguna.ref, { lagiPesanan: true });
      return Promise.resolve();
    })

    functions.logger.info("TIDAK ADA DRIVER UNTUK ORDER : ", snap.id);
    return;
  }

  const createDeliveryOrderForDriver = {
    customer_id: snap.get('customer_id'),
    unique_id: context.params.orderID,
    tipePaket: snap.get('tipePaket'),
    catatan: snap.get('catatan'),
    asalAlamat: snap.get('asalAlamat'),
    asalNama: snap.get('asalNama'),
    tujuanAlamat: snap.get('tujuanAlamat'),
    tujuanNama: snap.get('tujuanNama'),
    ongkosKirim: snap.get('ongkosKirim'),
    totalHarga: snap.get('totalHarga'),
    metodePembayaran: "CASH",
    terkonfirmasi: true,
    createdAt: snap.get('createdAt'),
    updatedAt: snap.get('updatedAt'),
    statusPesanan: "TERDAFTAR",
    jarak: 1,
  }

  let orderLuckyDriver = db.collection('userdriver').doc(luckyDriver.docs[0].id).collection('OrderAntar');
  orderLuckyDriver.add(createDeliveryOrderForDriver).then(references => {
    functions.logger.info("DRIVER DAPAT ORDER DELIVERY PAKET: ", references.id)
  })

  const updatePesanan = {
    jarak: 1,
    statusPesanan: "TERDAFTAR",
    namaDriver: luckyDriver.docs[0].get('namaDriver'),
    driverId: luckyDriver.docs[0].id,
    nomor_driver: luckyDriver.docs[0].get('noTelfon'),
  };

  await db.runTransaction((transaction) => {
    transaction.update(snap.ref, updatePesanan);
    // transaction.set(luckyDriver.docs[0].ref, createOrderForDriver);
    return Promise.resolve();
  })
}

async function findDriver(snap: DocumentSnapshot, context: functions.EventContext) {

  const currentMerchant = await db.collection("usersresto").doc(snap.data()["resto_id"]).get();

  const lat = 0.0144927536231884;
  const lon = 0.0181818181818182;

  const lowerLat = currentMerchant.get('latitude') - (lat * 2);
  const lowerLon = currentMerchant.get('longitude') - (lon * 2);

  const greaterLat = currentMerchant.get('latitude') + (lat * 2);
  const greaterLon = currentMerchant.get('longitude') + (lon * 2);

  const lesserGeopoint = {
    latitude: lowerLat,
    longitude: lowerLon,
  }

  const greaterGeopoint = {
    latitude: greaterLat,
    longitude: greaterLon,
  }

  const luckyDriver = await db.collection("userdriver").where("statusAktif", "==", true).where("pinLocation", ">=", lesserGeopoint).where("pinLocation", "<=", greaterGeopoint).get();

  if (luckyDriver.docs.length == 0) {
    const updatePesanan = {
      statusPesanan: "TIDAK_ADA_DRIVER",
    };
    
    await db.runTransaction((transaction) => {
      transaction.update(snap.ref, updatePesanan);
      // transaction.set(currentPengguna.ref, { lagiPesanan: true });
      return Promise.resolve();
    })

    functions.logger.info("TIDAK ADA DRIVER UNTUK ORDER : ", snap.id);
    return;
  }

  // const distance = calculateDistance(snapshot.after.data()["latitude"], snapshot.after.data()["longitude"], currentMerchant.data()["latitude"], currentMerchant.data()["longitude"], "K");

  const createOrderForDriver = {
    resto_id: snap.get('resto_id'),
    nama_resto: snap.get('nama_resto'),
    alamat_resto: snap.get('alamat_resto'),
    customer_id: snap.get('customer_id'),
    unique_id: context.params.orderID,
    biayaKirim: 3000,
    subTotal: snap.get('subTotal'),
    totalHarga: snap.get('totalHarga'),
    metodePembayaran: "CASH",
    terkonfirmasi: true,
    alamatRumah: snap.get('alamatRumah'),
    namaLengkap: snap.get('namaLengkap') ?? '',
    createdAt: snap.get('createdAt'),
    updatedAt: snap.get('updatedAt'),
    statusPesanan: "TERDAFTAR",
    pesanan: snap.get('pesanan'),
    jarak: 1,
  }

  const updatePesanan = {
    jarak: 1,
    statusPesanan: "TERDAFTAR",
    namaDriver: luckyDriver.docs[0].get('namaDriver'),
    driverId: luckyDriver.docs[0].id,
    nomor_driver: luckyDriver.docs[0].get('noTelfon'),
  };

  const createOrderForMerchant = {
    pesanan: snap.get('pesanan'),
    resto_id: snap.get('resto_id'),
    nama_resto: snap.get('nama_resto'),
    alamat_resto: snap.get('alamat_resto'),
    customer_id: snap.get('customer_id'),
    unique_id: context.params.orderID,
    biayaKirim: 3000,
    totalHarga: snap.get('totalHarga'),
    metodePembayaran: "CASH",
    terkonfirmasi: true,
    namaLengkap: snap.get('alamatRumah'),
    alamatRumah: snap.get('namaLengkap') ?? '',
    createdAt: snap.get('createdAt'),
    updatedAt: snap.get('updatedAt'),
    subTotal: snap.get('subTotal'),
    ongkosKirim: 3000,
    statusPesanan: "TERDAFTAR",
    namaDriver: luckyDriver.docs[0].get('namaDriver'),
    driverId: luckyDriver.docs[0].id,
    nomor_driver: luckyDriver.docs[0].get('noTelfon'),
  }

  let orderLuckyDriver = db.collection('userdriver').doc(luckyDriver.docs[0].id).collection('Order');
  orderLuckyDriver.add(createOrderForDriver).then(references => {
    functions.logger.info("DRIVER DAPAT ORDER: ", references.id)
  })

  let orderLuckyMerchant = currentMerchant.ref.collection('Order');
  orderLuckyMerchant.add(createOrderForMerchant).then(references => {
    functions.logger.info("MERCHANT DAPAT ORDER: ", references.id);
  })

  /*
  currentMerchant.ref.collection('Order').add(snap.data()).then((value) => {
    functions.logger.info("MERCHANT DAPAT ORDER: ", value.id);
    return Promise.resolve();
  });
  luckyDriver.docs[0].ref.collection('Order').add(createOrderForDriver).then((value) => {
    if (value.id) {
      
    }
    functions.logger.info("DRIVER DAPAT ORDER: ", value.id)
    return Promise.resolve();
  });
  */

  await db.runTransaction((transaction) => {
    transaction.update(snap.ref, updatePesanan);
    // transaction.set(luckyDriver.docs[0].ref, createOrderForDriver);
    return Promise.resolve();
  })

}

export const customerWriteDeliveryOrder = functions.region("asia-southeast2").firestore.document("/userpengguna/{userID}/OrderAntar/{orderID}").onCreate(async (snapshot, context) => {
  initialize();
  functions.logger.info("Ada Order Masuk Untuk Delivery: ", snapshot.data());
  functions.logger.info("Ada Order Masuk Untuk Delivery: ", snapshot.data()["asalNama"]);

  await findDeliveryOrder(snapshot, context);

});

export const customerWriteOrder = functions.region("asia-southeast2").firestore.document("/userpengguna/{userID}/Order/{orderID}").onCreate(async (snapshot, context) => {
  initialize();
  functions.logger.info("Ada Order Masuk dari Customer: ", snapshot.data());
  functions.logger.info("Ada Order Masuk dari Customer: ", snapshot.data()["namaLengkap"]);

  await findDriver(snapshot, context);

  // await pushNotificationToCustomer(snapshot.after, context);
})

export const orderNotFoundDriver = functions.region("asia-southeast2").firestore.document("/userpengguna/{userID}/Order/{orderID}").onUpdate(async (snapshot, context) => {
  initialize();
  if (snapshot.after.data()['statusPesanan'] == "TIDAK_ADA_DRIVER") {
    await db.runTransaction((transaction) => {
      transaction.delete(snapshot.after.ref);
      return Promise.resolve();
    })
  }
})

export const driverGotOrder = functions.region("asia-southeast2").firestore.document("/userdriver/{userID}/Order/{orderID}").onCreate(async (snapshot, context) => {
  initialize();
  const currentDriver = await db
    .collection("userdriver")
    .doc(context.params.userID)
    .get();

    if (snapshot.data()['statusPesanan'] == 'TERDAFTAR') {
      functions.logger.info("Order Masuk Untuk Driver: ", snapshot.data());
      functions.logger.info("Order Masuk Untuk Driver Bernama: ", currentDriver.data()["namaDriver"]);

      await pushNotificationToDriver(currentDriver, snapshot, context);
    }
})

export const customerDeleteOrder = functions.region("asia-southeast2").firestore.document("/userpengguna/{userID}/Order/{orderID}").onDelete(async (snapshot, context) => {
  // snapshot

})

export const merchantGotOrder = functions.region("asia-southeast2").firestore.document("/usersresto/{restoID}/Order/{orderID}").onWrite(async (snapshot, context) => {
  initialize();
})

export const updateOrderAntar = functions.region("asia-southeast2").firestore.document("/userdriver/{driverId}/OrderAntar/{orderId}").onUpdate(async (snapshot, context) => {
  initialize();
  functions.logger.info("Driver Yang Menerima Order: ", snapshot.after.data());
  functions.logger.info("Custo")
});

export const updateTestFeeOrder = functions.region("asia-southeast2").firestore
.document("/userdriver/{driverId}/Order/{orderId}")
.onUpdate(async (snapshot, context) => {
  initialize();
  if (snapshot.after.data()["statusPesanan"] == "DRIVER_SELESAI") {
    functions.logger.info("DRIVER BENAR2 SELESAI");
    await processFeeUpdateOrder(context.params.driverId, snapshot.after);
    await pushNotificationToCustomer(snapshot.after, context);
  } else {
    functions.logger.info("DRIVER STATUS: ", snapshot.after.data()["statusPesanan"]);
    await pushNotificationToCustomer(snapshot.after, context);
  }
});

export const updateOrder = functions.region("asia-southeast2").firestore
  .document("/userdriver/{driverId}/Order/{orderId}")
  .onUpdate(async (snapshot, context) => {
    initialize();

    /*
    switch (snapshot.after.data["statusPesanan"]) {
      case "DRIVER_SELESAI": {
        pushNotificationToCustomer(snapshot.after, context);
        processUpdateOrder(context.params.driverId, snapshot.after, context);
        break;
      }
      case "DRIVER_TERIMA": {
        functions.logger.info("DRIVER Sudah Mengambil Pesanan");
        pushNotificationToCustomer(snapshot.after, context);
        break;
      }
      case "MERCHANT_PROSES": {
        functions.logger.info("Merchant Proses Pesanan");
        pushNotificationToCustomer(snapshot.after, context);
        break;
      }
      case "DRIVER_AMBIL": {
        functions.logger.info("Driver Mengecek Belanjaan");
        pushNotificationToCustomer(snapshot.after, context);
        break;
      }
      case "DRIVER_ANTAR": {
        functions.logger.info("Menuju Destinasi");
        pushNotificationToCustomer(snapshot.after, context);
        break;
      }
      case "DRIVER_SELESAI": {
        functions.logger.info("Driver Selesai");
        pushNotificationToCustomer(snapshot.after, context);
        break;
      }
      default: {
        return;
      }
    }
    */

    if (snapshot.after.data()["statusPesanan"] == "DRIVER_SELESAI") {
        functions.logger.info("DRIVER BENAR2 SELESAI");
      await processUpdateOrder(context.params.driverId, snapshot.after, context);
      await pushNotificationToCustomer(snapshot.after, context);
    } else {
      functions.logger.info("DRIVER STATUS: ", snapshot.after.data()["statusPesanan"]);
      await pushNotificationToCustomer(snapshot.after, context);
    }
  });


export const useWildCart = functions.firestore
  .document('users/{userId}')
  .onWrite((change, context) => {
    // If we set `/users/marie` to {name: "Marie"} then

    // ... and ...
    // change.after.data() == {name: "Marie"}
  });

export const testFCMOrderBoard = functions.region('asia-southeast2').https.onRequest(
  (request, response) => {
    
    initialize();
    const registrationToken =
      "eVvHiw4qR-KeFX35s351Ky:APA91bFBWQVFie4MjF_ONcsYB5T_OnS4yHi7nGjIFRtn7GqwTmjkFMWaiiLSgHlOQyr6hhVDaUEvoCPY4exe6FkSwslsX_w_GQ043Cuoq_o1L0JNIArmjDx41WU-PcEHWaFLflnvDuhY";

    const testingPayload = {
      token: registrationToken,
      data: {
        via: "GIAT Antar FCM",
        orderID: "eenKUZ0cYRa5SSvx8YEa",
        customer_id: "A0iOESXFzaXnLIx1xzEc3fGpe5q2",
        merchant_id: "NXT91J0ztsf8dO1L0GlBwbZpblT2",
        type_key: "ORDER_ONBOARDING",
        order_type: "ORDER_FOOD",
        count: "1",
      },
      notification: {
        title: "GIAT Driver!",
        body: "Ada Pesanan Siap Driver!",
      },
      android: {
        priority: "high" as const,
        ttl: 0,
        notification: {
          priority: "max" as const,
          visibility: "public" as const,
          vibrateTimingsMillis: [2, 4, 2, 4, 2],
          clickAction: 'android.intent.action.MAIN'
        },
      },
    };

    /*
                android: {
            ttl: '0s',
            priority: 'high',
            notification: {
              visibility: 'public',
              notification_priority: 'PRIORITY_MAX',
              vibrate_timings: ['3s', '3s', '3s', '3s', '3s'],
            }
          }
      */
    // sendFcmMessage(buildOverrideMessage);

    messaging
      .send(testingPayload)
      .then((responsePayload) => {
        // Response is a message ID string.
        functions.logger.info("Successfully sent message:", responsePayload);
        // console.log('Successfully sent message:', response);
        response.send({ code: responsePayload });
      })
      .catch((error) => {
        console.log("Error sending message:", error);
      });
  }
);
