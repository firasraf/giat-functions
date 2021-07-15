import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { DocumentSnapshot, snapshotConstructor } from "firebase-functions/lib/providers/firestore";
import { eventarc_v1, google } from 'googleapis';
import https from 'https';
import { docs } from "googleapis/build/src/apis/docs";
import { spawn } from "child-process-promise";
import { Storage } from "@google-cloud/storage";
import fs from 'fs';
import mkdirp from 'mkdirp';

import os from 'os';
import path from 'path';

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

const lat = 0.0144927536231884;
const lon = 0.0181818181818182;

let db: FirebaseFirestore.Firestore;
let messaging: admin.messaging.Messaging;
let storage: admin.storage.Storage;
let initialized = false;

// let gcpStorage: Storage;


function initialize() {
  if (initialized === true) return;
  initialized = true;
  admin.initializeApp();
  messaging = admin.messaging();
  storage = admin.storage();
  db = admin.firestore();
}


function getStatusOrderFromNotification(status: String) {
  var statusBody;
  switch (status) {
    case "DRIVER_TERIMA": {
      statusBody = "Driver Menerima Pesanan Anda. Menuju Penjual"
      break;
    }
    case "MERCHANT_PROSES": {
      statusBody = "Penjual menerima pesanan"
      break;
    }
    case "DRIVER_AMBIL": {
      statusBody = "Mengambil Pesanan di Penjual"
      break;
    }
    case "DRIVER_ANTAR": {
      statusBody = "Makanan Siap. Menuju ke Destinasi Anda";
      break;
    }
    case "DRIVER_SELESAI": {
      statusBody = "Terima kasih bersama GIAT. Enjoy your food!";
      break;
    }
    default: {
      break;
    }
  }
  return statusBody;
}

async function processDeliveryFeeOrder(driverId: string, snap: DocumentSnapshot) {
  const currentDriver = await db
    .collection("userdriver")
    .doc(driverId)
    .get();

  const representativeInternal = await db.collection("giatrepresentative").doc('quD2wq4uH22ZrzdnJCrr').get();

  const currentBalance = currentDriver.get("balance");

  const ongkosKirim = snap.get("ongkosKirim");

  const driverFee = ongkosKirim * 0.25;

  const driverCurrentBalance = (currentBalance - driverFee | 0);
  functions.logger.info("Driver BALANCE FOR NOW: ", driverCurrentBalance);

  const updateInternal = {
    totalDriverFee: representativeInternal.data()['totalDriverFee'] + driverFee,
    grossRevenue: representativeInternal.data()['grossRevenue'] + ongkosKirim,
    transactions: representativeInternal.data()['transactions'] + 1,
    giatRevenue: representativeInternal.data()['giatRevenue'] + driverFee,
  }

  const update = {
    balance: driverCurrentBalance,
    onDelivery: false,
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

async function processFeeUpdateOrder(driverId: string, snap: DocumentSnapshot) {

  const currentDriver = await db
    .collection("userdriver")
    .doc(driverId)
    .get();

  const representativeInternal = await db.collection("giatrepresentative").doc('quD2wq4uH22ZrzdnJCrr').get();

  const currentBalance = currentDriver.get("balance");

  const subTotal = snap.get("subTotal");
  const ongkosKirim = snap.get("biayaKirim");

  var quantityTotal = 0;
  snap.get("pesanan").map(element => {
    functions.logger.info(element);
    quantityTotal += element['jumlah'] * 1000;
  });

  const merchantFee = quantityTotal;
  const dividedFee = merchantFee * 0.5;
  functions.logger.info("Divided Fee", dividedFee);
  const driverFee = ongkosKirim * 0.25;

  const giatRevenue = (ongkosKirim * 0.25) + dividedFee;

  const updateInternal = {
    totalDriverFee: representativeInternal.data()['totalDriverFee'] + driverFee,
    totalMerchantFee: representativeInternal.data()['totalMerchantFee'] + dividedFee,
    grossRevenue: representativeInternal.data()['grossRevenue'] + (subTotal + ongkosKirim),
    transactions: representativeInternal.data()['transactions'] + 1,
    giatRevenue: representativeInternal.data()['giatRevenue'] + giatRevenue,
  }

  // parse
  const driverCurrentBalance = (currentBalance - (driverFee + dividedFee) | 0)
  functions.logger.info("Driver BALANCE FOR NOW: ", driverCurrentBalance);

  const update = {
    balance: driverCurrentBalance,
    onDelivery: false,
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

const THUMB_MAX_HEIGHT = 600;
const THUMB_MAX_WIDTH = 600;


async function checkExceededFiles() {
  const restoBucket = await storage.bucket();
  const customIntercept = {
    request: function(reqOpts) {
        reqOpts.forever = false;
        return reqOpts
    }
  }
  restoBucket.interceptors.push(customIntercept);

  const restoDirs = await restoBucket.getFiles({
    directory: "imagesResto"
  });

  restoDirs[0].map(async (file) => {
    const filePath = file.name;
    const fileBucket = file.bucket;
    const metadataSize = file.metadata;

    if (metadataSize.size > 1000000) {
      const fileName = path.basename(filePath);
      const newContentType = file.metadata.contentType;

      // const bucket = admin.storage().bucket(fileBucket.name);
      const tempPathFile = path.join(os.tmpdir(), fileName);
      functions.logger.log('Temp Path File Size', metadataSize.size);

      await restoBucket.file(filePath).download({destination: tempPathFile});
      functions.logger.log('Image downloaded locally to', tempPathFile);
      // Generate a thumbnail using ImageMagick.
      await spawn('convert', [tempPathFile, '-thumbnail', '600x600>', tempPathFile]);
      functions.logger.log('Thumbnail created at', tempPathFile);
      // We add a 'thumb_' prefix to thumbnails file name. That's where we'll upload the thumbnail.
      const thumbFileName = `thumb_${fileName}`;
      const thumbFilePath = path.join(path.dirname(filePath), thumbFileName);
      // Uploading the thumbnail.
      await restoBucket.upload(tempPathFile, {
        destination: thumbFilePath,
        contentType: newContentType
      });
      
      const thumbFile = restoBucket.file(thumbFileName);
      const results = await Promise.all([
        thumbFile.getSignedUrl({
          action: 'read',
          expires: '03-01-2500',
        }),
      ]);

      return functions.logger.log('Thumbnail created at', results[0]);
      
      /*
      const selectedMerchant = await db.collection('usersresto').doc(fileName).get();

      const updateProfil = {
        fotoprofilURL: results[0]
      }

      await db.runTransaction((transaction) => {
        transaction.update(selectedMerchant.ref, updateProfil);
        return Promise.resolve();
      });
      */
      
    }

  })
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

// async function schedule(snap)

async function pushNotificationDeliveryToDriver(snapDriver: DocumentSnapshot, snap: DocumentSnapshot, context: functions.EventContext) {

  const gotToken = snapDriver.get("token");

  const testingPayload = {
    token: gotToken,
    data: {
      via: "GIAT Antar FCM",
      deliveryID: snap.id,
      customer_id: snap.data()["customer_id"],
      type_key: "ORDER_ONBOARDING",
      order_type: "ORDER_DELIVERY",
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

async function updateOrderCustomer(snap: DocumentSnapshot, context: functions.EventContext) {
  const customerOrder = await db.collection('userpengguna').doc(snap.data()["customer_id"]).collection('Order').doc(snap.data()["unique_id"]).get();

    const updatePesanan = {
      statusPesanan: snap.data()["statusPesanan"],
    };

    await db.runTransaction((transaction) => {
      transaction.update(customerOrder.ref,  updatePesanan);
      // transaction.set(currentPengguna.ref, { lagiPesanan: true });
      return Promise.resolve();
    })
}

async function pushNotificationToCustomer(snap: DocumentSnapshot, context: functions.EventContext) {
    const currentPengguna = await db.collection('userpengguna').doc(snap.data()["customer_id"]).get();
    const customerOrder = await db.collection('userpengguna').doc(snap.data()["customer_id"]).collection('Order').doc(snap.data()["unique_id"]).get();
    const gotToken = currentPengguna.get("token");
    const getStatusBody = getStatusOrderFromNotification(snap.data()['statusPesanan']);

    const updatePesanan = {
      statusPesanan: snap.data()["statusPesanan"],
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
        apns: {
          payload: {
            aps: {
              alert: {
                title: "GIAT!",
                body: getStatusBody,
              },
              contentAvailable: true,
            }
          },
          headers: {
            "apns-push-type": "background",
            "apns-priority": "5",
            "apns-topic": "com.giatlancar.giat"
          }
        }
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
        // await pushNotificationToCustomer(snapshot.after, context);
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

  // Customer Write Order, Provided LatLng..

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
      statusPesanan: "TIDAK_ADA_DRIVER",
    };
    
    await db.runTransaction((transaction) => {
      transaction.update(snap.ref, updatePesanan);
      // transaction.set(currentPengguna.ref, { lagiPesanan: true });
      return Promise.resolve();
    })

    functions.logger.info("TIDAK ADA DRIVER UNTUK ORDER DELIVERY: ", snap.id);
    return;
  }

  const createDeliveryOrderForDriver = {
    customer_id: snap.get('customer_id'),
    unique_id: context.params.orderID,
    tipePaket: snap.get('tipePaket'),
    catatan: snap.get('catatan'),
    asalAlamat: snap.get('asalAlamat'),
    asalNama: snap.get('asalNama'),
    asalFormatted: snap.get('asalFormatted'),
    asalNote: snap.get('asalNote'),
    tujuanAlamat: snap.get('tujuanAlamat'),
    tujuanNama: snap.get('tujuanNama'),
    tujuanNote: snap.get('tujuanNote'),
    tujuanFormatted: snap.get('tujuanFormatted'),
    ongkosKirim: snap.get('ongkosKirim'),
    totalHarga: snap.get('totalHarga'),
    metodePembayaran: "CASH",
    terkonfirmasi: true,
    createdAt: snap.get('createdAt'),
    updatedAt: snap.get('updatedAt'),
    statusPesanan: "TERDAFTAR",
    originPos: snap.get("originPos"),
    destPos: snap.get("destPos"),
    jarak: snap.get("jarak"),
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

async function confirmedMerchantOrder(snap: DocumentSnapshot, context: functions.EventContext) {
  const currentMerchant = await db.collection("usersresto").doc(snap.data()["resto_id"]).get();

  const findOrders = await currentMerchant.ref.collection("Order").where("unique_id", "==", snap.data()["unique_id"]).get();
  const selectedOrder = findOrders.docs[0];

  const confirmedPesananMerchant = {
    statusPesanan: snap.get("statusPesanan"),
  };

  await db.runTransaction((transaction) => {
    transaction.update(selectedOrder.ref, confirmedPesananMerchant);
    functions.logger.info("SUKSES KONFIRMASI ORDER MERCHANT: ", selectedOrder.id);
    return Promise.resolve();
  })
}

async function findDriver(snap: DocumentSnapshot, context: functions.EventContext) {

  const currentMerchant = await db.collection("usersresto").doc(snap.data()["resto_id"]).get();

  const lat = 0.0144927536231884;
  const lon = 0.0181818181818182;

  const createOrderForDriver = {
    resto_id: snap.get('resto_id'),
    nama_resto: snap.get('nama_resto'),
    alamat_resto: snap.get('alamat_resto'),
    customer_id: snap.get('customer_id'),
    unique_id: context.params.orderID,
    biayaKirim: snap.get('biayaKirim'),
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

  if (currentMerchant.get('latitude') == null && currentMerchant.get('longitude') == null) {
    functions.logger.error("MERCHANT TIDAK ADA DATA LAT AND LONG")    
    const luckyDriver2 = await db.collection("userdriver").where("statusAktif", "==", true).where("balance", ">=", snap.data()["subTotal"]).get();

    if (luckyDriver2.docs.length == 0) {
      const updatePesanan = {
        statusPesanan: "TIDAK_ADA_DRIVER",
      };
      
      await db.runTransaction((transaction) => {
        transaction.update(snap.ref, updatePesanan);
        return Promise.resolve();
      })
  
      functions.logger.info("DRIVER TIDAK ADA YANG AKTIF UNTUK ORDER: ", snap.id);
      return;
    }

    functions.logger.info("Coba Coba panggil Alternatif Driver: ", luckyDriver2.docs[0].get('namaDriver'))
  
    const createOrderForMerchant = {
      pesanan: snap.get('pesanan'),
      resto_id: snap.get('resto_id'),
      nama_resto: snap.get('nama_resto'),
      alamat_resto: snap.get('alamat_resto'),
      customer_id: snap.get('customer_id'),
      unique_id: context.params.orderID,
      biayaKirim: snap.get('biayaKirim'),
      totalHarga: snap.get('totalHarga'),
      metodePembayaran: "CASH",
      terkonfirmasi: true,
      namaLengkap: snap.get('namaLengkap'),
      alamatRumah: snap.get('alamatRumah') ?? '',
      createdAt: snap.get('createdAt'),
      updatedAt: snap.get('updatedAt'),
      subTotal: snap.get('subTotal'),
      ongkosKirim: 3000,
      statusPesanan: "TERDAFTAR",
      namaDriver: luckyDriver2.docs[0].get('namaDriver'),
      driverId: luckyDriver2.docs[0].id,
      nomor_driver: luckyDriver2.docs[0].get('noTelfon'),
    }

    const updatePesananAlternative = {
      jarak: 1,
      statusPesanan: "TERDAFTAR",
      namaDriver: luckyDriver2.docs[0].get('namaDriver'),
      driverId: luckyDriver2.docs[0].id,
      nomor_driver: luckyDriver2.docs[0].get('noTelfon'),
    };


    let orderLuckyDriver = db.collection('userdriver').doc(luckyDriver2.docs[0].id).collection('Order');
    orderLuckyDriver.add(createOrderForDriver).then(references => {
      functions.logger.info("DRIVER Alternative DAPAT ORDER: ", references.id)
    })

    let orderLuckyMerchant = currentMerchant.ref.collection('Order');
    orderLuckyMerchant.add(createOrderForMerchant).then(references => {
      functions.logger.info("MERCHANT DAPAT ORDER: ", references.id);
    })

    await db.runTransaction((transaction) => {
      transaction.update(snap.ref, updatePesananAlternative);
      return Promise.resolve();
    })
  } else {
    
    const lowerLat = currentMerchant.get('latitude') - (lat * 5);
    const lowerLon = currentMerchant.get('longitude') - (lon * 5);

    const greaterLat = currentMerchant.get('latitude') + (lat * 5);
    const greaterLon = currentMerchant.get('longitude') + (lon * 5);

    const lesserGeopoint = {
      latitude: lowerLat,
      longitude: lowerLon,
    }

    const greaterGeopoint = {
      latitude: greaterLat,
      longitude: greaterLon,
    }

    const luckyDriver = await db.collection("userdriver").where("statusAktif", "==", true)
      .where("pinLocation", ">=", lesserGeopoint)
      .where("pinLocation", "<=", greaterGeopoint).where("onDelivery", "==", false).get();

      if (luckyDriver.docs.length == 0) {
          const updatePesanan = {
          statusPesanan: "TIDAK_ADA_DRIVER",
      };
    
      await db.runTransaction((transaction) => {
        transaction.update(snap.ref, updatePesanan);
        return Promise.resolve();
      })

      functions.logger.info("TIDAK ADA DRIVER DI JANGKAUAN MERCHANT UNTUK ORDER : ", snap.id);
      return;
    }

    functions.logger.info("ADA BERAPA DRIVER AVAILABLE : ", luckyDriver.docs.length);

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
      biayaKirim: snap.get('biayaKirim'),
      totalHarga: snap.get('totalHarga'),
      metodePembayaran: "CASH",
      terkonfirmasi: true,
      namaLengkap: snap.get('namaLengkap'),
      alamatRumah: snap.get('alamatRumah') ?? '',
      createdAt: snap.get('createdAt'),
      updatedAt: snap.get('updatedAt'),
      subTotal: snap.get('subTotal'),
      ongkosKirim: 3000,
      statusPesanan: "TERDAFTAR",
      namaDriver: luckyDriver.docs[0].get('namaDriver'),
      driverId: luckyDriver.docs[0].id,
      nomor_driver: luckyDriver.docs[0].get('noTelfon'),
    }

    if (luckyDriver.docs[0].get('balance') <= 0) {
      let orderLuckyDriver = db.collection('userdriver').doc(luckyDriver.docs[1].id).collection('Order');
      orderLuckyDriver.add(createOrderForDriver).then(references => {
        functions.logger.info("DRIVER #1 DAPAT ORDER: ", references.id)
      })
    } else {
      let orderLuckyDriver = db.collection('userdriver').doc(luckyDriver.docs[0].id).collection('Order');
      orderLuckyDriver.add(createOrderForDriver).then(references => {
        functions.logger.info("DRIVER #4 DAPAT ORDER: ", references.id)
      })
    }

    let orderLuckyMerchant = currentMerchant.ref.collection('Order');
    orderLuckyMerchant.add(createOrderForMerchant).then(references => {
      functions.logger.info("MERCHANT DAPAT ORDER: ", references.id);
    })

    await db.runTransaction((transaction) => {
      transaction.update(snap.ref, updatePesanan);
    // transaction.set(luckyDriver.docs[0].ref, createOrderForDriver);
      return Promise.resolve();
    })

  }
}

export const generateMerchantThumbnail = functions.region("asia-southeast2").storage.object().onFinalize(async (object) => {
  const fileBucket = object.bucket; // The Storage bucket that contains the file.
  const filePath = object.name; // File path in the bucket.
  const contentType = object.contentType; // File content type.
  const metageneration = object.metageneration; // 

  // [START stopConditions]
  // Exit if this is triggered on a file that is not an image.
  if (!contentType.startsWith('image/')) {
    return functions.logger.log('This is not an image.');
  }

  // Get the file name.
  const fileName = path.basename(filePath);
  // Exit if the image is already a thumbnail.
  if (fileName.startsWith('thumb_')) {
    return functions.logger.log('Already a Thumbnail.');
  }

  const bucket = admin.storage().bucket(fileBucket);
  const tempFilePath = path.join(os.tmpdir(), fileName);
  const metadata = {
    contentType: contentType,
  };
  await bucket.file(filePath).download({destination: tempFilePath});
  functions.logger.log('Image downloaded locally to', tempFilePath);
  // Generate a thumbnail using ImageMagick.
  await spawn('convert', [tempFilePath, '-thumbnail', '600x600>', tempFilePath]);
  functions.logger.log('Thumbnail created at', tempFilePath);
  // We add a 'thumb_' prefix to thumbnails file name. That's where we'll upload the thumbnail.
  const thumbFileName = `thumb_${fileName}`;
  const thumbFilePath = path.join(path.dirname(filePath), thumbFileName);
  // Uploading the thumbnail.
  await bucket.upload(tempFilePath, {
    destination: thumbFilePath,
    metadata: metadata,
  });

  return fs.unlinkSync(tempFilePath);
})

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

// export const findDumbedOrderAndMoving = function.

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

    const updateDriverStatus = {
      onDelivery: true,
    };

    if (snapshot.data()['statusPesanan'] == 'TERDAFTAR') {
      functions.logger.info("Order Masuk Untuk Driver: ", snapshot.data());
      functions.logger.info("Order Masuk Untuk Driver Bernama: ", currentDriver.data()["namaDriver"]);

      await db.runTransaction((transaction) => {
        transaction.update(currentDriver.ref, updateDriverStatus);
      // transaction.set(luckyDriver.docs[0].ref, createOrderForDriver);
        return Promise.resolve();
      })

      await pushNotificationToDriver(currentDriver, snapshot, context);
    }
})

export const driverDeliveryANTARGotOrder = functions.region("asia-southeast2").firestore.document("/userdriver/{userID}/OrderAntar/{orderID}").onCreate(async (snapshot, context) => {
  initialize();
  const currentDriver = await db
    .collection("userdriver")
    .doc(context.params.userID)
    .get();

    const updateDriverStatus = {
      onDelivery: true,
    };

    if (snapshot.data()['statusPesanan'] == 'TERDAFTAR') {
      functions.logger.info("Order Masuk Untuk Driver: ", snapshot.data());
      functions.logger.info("Order Masuk Untuk Driver Bernama: ", currentDriver.data()["namaDriver"]);

      await db.runTransaction((transaction) => {
        transaction.update(currentDriver.ref, updateDriverStatus);
      // transaction.set(luckyDriver.docs[0].ref, createOrderForDriver);
        return Promise.resolve();
      })

      // await pushNotificationToDriver(currentDriver, snapshot, context);
      await pushNotificationDeliveryToDriver(currentDriver, snapshot, context);
    }
})

export const customerDeleteOrder = functions.region("asia-southeast2").firestore.document("/userpengguna/{userID}/Order/{orderID}").onDelete(async (snapshot, context) => {
  // snapshot

})

export const merchantGotOrder = functions.region("asia-southeast2").firestore.document("/usersresto/{restoID}/Order/{orderID}").onWrite(async (snapshot, context) => {
  initialize();

})

export const merchantDeleteOrder = functions.region("asia-southeast2").firestore.document("/usersresto/{restoID}/Order/{orderID}").onWrite(async (snapshot, context) => {
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
    // functions.logger.info("DRIVER BENAR2 SELESAI");
    await processFeeUpdateOrder(context.params.driverId, snapshot.after);
    // await pushNotificationToCustomer(snapshot.after, context);
    await updateOrderCustomer(snapshot.after, context);
    await confirmedMerchantOrder(snapshot.after, context);
  } else if (snapshot.after.data()["statusPesanan"] == "DRIVER_ANTAR") {
    await pushNotificationToCustomer(snapshot.after, context);
  } else if (snapshot.after.data()["statusPesanan"] == "DRIVER_TERIMA") {
    await pushNotificationToCustomer(snapshot.after, context);
    // functions.logger.info("DRIVER STATUS: ", snapshot.after.data()["statusPesanan"]);
  } else {
    await updateOrderCustomer(snapshot.after, context);
    // functions.logger.info("DRIVER STATUS: ", snapshot.after.data()["statusPesanan"]);
  }
});

export const updateDeliveryFeeOrder = functions.region("asia-southeast2").firestore.document("/userdriver/{driverId}/OrderAntar/{orderId}").onUpdate(async (snapshot, context) => { 
  initialize();
  if (snapshot.after.data()["statusPesanan"] == "DRIVER_SELESAI") {
    await processDeliveryFeeOrder(context.params.driverId, snapshot.after);
  }
});

export const driverUpdateOrder = functions.region("asia-southeast2").firestore
  .document("/userdriver/{driverId}/Order/{orderId}")
  .onUpdate(async (snapshot, context) => {
    initialize();
    const currentDriver = await db
    .collection("userdriver")
    .doc(context.params.driverId)
    .get();

    const updateDriverStatus = {
      onDelivery: true,
    };

    const onDeliveryOff = {
      onDelivery: false,
    }

    const updateStatusMerchant = {
      statusPesanan: "DRIVER_SELESAI",
    }

    if (snapshot.after.data()["statusPesanan"] == "DRIVER_AMBIL") {
      await confirmedMerchantOrder(snapshot.after, context);
      await db.runTransaction((transaction) => {
        transaction.update(currentDriver.ref, updateDriverStatus);
        return Promise.resolve();
      })
    } else if (snapshot.after.data()["statusPesanan"] == "DRIVER_TERIMA") {
      await confirmedMerchantOrder(snapshot.after, context);
      await db.runTransaction((transaction) => {
        transaction.update(currentDriver.ref, updateDriverStatus);
        return Promise.resolve();
      })
    } else if (snapshot.after.data()["statusPesanan"] == "DRIVER_ANTAR") {
      await confirmedMerchantOrder(snapshot.after, context);
      await db.runTransaction((transaction) => {
        transaction.update(currentDriver.ref, onDeliveryOff);
        return Promise.resolve();
      })
    }

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

});

export const scheduledMerchantStorage = functions.region("asia-southeast2").pubsub.schedule('every 5 minutes').onRun( async (context) => {
  initialize();

  await checkExceededFiles();
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
