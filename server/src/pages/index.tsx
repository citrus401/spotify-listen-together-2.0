import type { NextPage } from 'next';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import SongInfo from '../../backend/web-shared/songInfo';
import config from '../../config';
import ClientList from '../components/clientList';
import Header from '../components/header';
import Song from '../components/song';
import styles from '../styles/Index.module.css';
import Head from 'next/head';

const Index: NextPage = () => {
  const [songInfo, setSongInfo] = useState<SongInfo | undefined>(undefined);
  const [clients, setClients] = useState<any>([]);

  useEffect(() => {
    const socket = io();

    socket.on("songInfo", (songInfo: SongInfo) => setSongInfo(songInfo));
    socket.on("listeners", (clients: any) => setClients(clients));

    socket.on("connect", () => {
      console.log("connected!");
      socket.emit("requestSongInfo");
      socket.emit("requestListeners");
      socket.emit("requestQueue");
    });
  }, []);

  const openSpotify = () => {
    window.open(`spotify:listentogether:${encodeURIComponent(typeof location !== 'undefined' ? location.protocol + '//' + location.host : "")}`, '_self');
  };

  return (
<main className={styles.main}>
  <Head>
    <link rel="shortcut icon" href="/static/favicon.ico" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
    <link rel="icon" type="image/png" sizes="96x96" href="/favicon-96x96.png" />
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
  </Head>
  <Header />
  <div className={styles.contentContainer}>
    <h1 className={styles.header}>Your friends are currently listening to...</h1>
    <Song song={songInfo} />
    <h2 className={styles.header}>Who&apos;s listening?</h2>
    <ClientList listeners={clients} />
    <button className={styles.button} onClick={openSpotify}>Listen with them!</button>
    <Link href="/instructions" passHref>
      <button className={`${styles.button} ${styles.subButton}`}>Download</button>
    </Link>
  </div>
  <footer className={styles.footer}>
    <a href='https://github.com/FlafyDev/spotify-listen-together'>
      <img src='/images/Github.png' width={64} alt="Github" />
    </a>
    <p>Made by <a href='https://github.com/FlafyDev'>FlafyDev</a></p>
    <p>Recommended client v{config.clientRecommendedVersion}</p>
  </footer>
</main>
  );
}

export default Index;